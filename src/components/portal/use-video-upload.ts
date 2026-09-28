"use client";

import { useEffect, useRef, useState } from "react";
import {
  extractFrames,
  isRetryableFrameError,
  probeError,
  putWithProgress,
  uploadFrameBlobs,
  type FrameErrorCode,
  type FramesReport,
} from "@/lib/frames-client";
import {
  planParts,
  remainingParts,
  requestPartUrls,
  resumeDecision,
  resumeKey,
  runMultipartUpload,
  browserMultipartDeps,
  URL_MAX_AGE_MS,
  UploadGoneError,
  type MultipartStatus,
  type ResumeRecord,
  type UploadedPart,
} from "@/lib/multipart-client";
import { deleteResume, loadResume, pruneResume, saveResume } from "@/lib/upload-resume-store";
import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_BYTES } from "@/lib/validation";
import type { DuplicateMatch } from "@/lib/portal-duplicate";

/**
 * Video kuyruğu — yükleme akışının MANTIĞI (README §7, V7b). Görünüm
 * `upload-form.tsx`'te; mobil arayüz yeniden tasarlandığında bu hook olduğu
 * gibi bağlanabilsin diye ayrı.
 *
 *   1. Her dosya tarayıcıda ölçülür (≤ 90 sn, dikey) ve 6 kare çıkarılır.
 *   2. Aynı dosya için yarım kalmış bir çok parçalı yükleme kaydı varsa
 *      (IndexedDB) o taslaktan devam edilir. Diğerleri için önce "aynı video"
 *      kontrolü: daha önce yüklenmiş görünen dosya kullanıcıya sorulur ve
 *      kararını beklerken ötekiler yüklenir. Geçen dosyalar için TEK istekte
 *      taslak + yükleme bilgisi alınır.
 *   3. Küçük video tek PUT'la, büyük video parça parça R2'ye gider.
 *   4. `complete` dosyanın gerçekten yüklendiğini doğrular ve kuyruğa ekler;
 *      gövdesindeki kare raporu karesiz kalan videonun NEDENİNİ sunucuya taşır.
 *
 * Videolar SIRAYLA yüklenir: telefonda paralel 300 MB'lık yüklemeler bant
 * genişliğini bölüp hepsini yavaşlatır, biri koptuğunda da hangisinin
 * bittiği belirsizleşir. (Parçalar ise video İÇİNDE 3'erli paralel.)
 */

export type ItemPhase =
  | "bekliyor"
  | "hazırlanıyor"
  | "soruluyor"
  | "atlandı"
  | "yükleniyor"
  | "tamamlanıyor"
  | "bitti"
  | "hata";

export type ItemState = {
  key: string;
  name: string;
  size: number;
  phase: ItemPhase;
  progress: number;
  error?: string;
  note?: string;
  /** Yükleme sırasındaki anlık durum ("Bağlantı bekleniyor" gibi). */
  status?: string;
  /** İlk karenin `data:` adresi — kartta doğru videonun seçildiği görülsün. */
  thumb?: string;
  /** "soruluyor"/"atlandı": daha önce yüklenmiş eşi. */
  duplicate?: DuplicateMatch;
};

/**
 * Karttaki önizleme için. Sayfanın CSP'si görsellerde `blob:` adresine izin
 * vermiyor (`img-src 'self' data: https:`), `data:` adresine veriyor.
 */
function toDataUrl(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    } catch {
      resolve(undefined);
    }
  });
}

type UploadTarget =
  | { postId: string; multipart: false; videoPutUrl: string; framePutUrls: string[] }
  | { postId: string; multipart: true; partSize: number; framePutUrls: string[] };

type Prepared = {
  file: File;
  key: string;
  frames: Blob[];
  frameError?: FrameErrorCode;
  resume: ResumeRecord | null;
};

export const MAX_FILES = 20;

/** Dışa açık: görünüm "bekleyen" durumları (turuncu kart) bu metinlerle ayırt ediyor. */
export const STATUS_TEXT: Record<Exclude<MultipartStatus, "uploading">, string> = {
  "waiting-network": "Bağlantı bekleniyor",
  "waiting-visible": "Uygulamaya dönünce devam eder",
  retrying: "Bağlantı koptu, yeniden deneniyor",
};
const RESUMED_TEXT = "Devam ediyor…";
const RESUME_HINT = "Aynı videoyu yeniden seçersen kaldığı yerden devam eder";
const NO_FRAMES_NOTE = "Kare çıkarılamadı; caption yalnızca sesten üretilecek";

/** Uzantıdan beklenen tip — tarayıcının verdiği tip işe yaramadığında. */
const EXTENSION_TYPES: [string, string][] = [
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
];

/**
 * Tarayıcılar `.mov` için bazen boş tip (Windows Chrome), bazen
 * `application/octet-stream` (bazı Windows/Android tarayıcıları) veriyor.
 * İzinli bir video tipi değilse uzantıdan tamamlanıyor; eskiden yalnızca BOŞ
 * tip tamamlanıyordu ve `octet-stream` sunucuya olduğu gibi gidip reddediliyordu
 * (2026-09-28 analizinde görüldü). İmzalı PUT'un tipi de AYNI fonksiyondan
 * gelmeli, yoksa R2 imza uyuşmazlığıyla 403 döner.
 */
export function videoType(file: File): string {
  if (ALLOWED_VIDEO_TYPES[file.type]) return file.type;
  const name = file.name.toLowerCase();
  for (const [extension, type] of EXTENSION_TYPES) {
    if (name.endsWith(extension)) return type;
  }
  return file.type;
}

/**
 * Sunucunun `validateVideoUpload` kuralının seçimdeki karşılığı. Sunucu
 * toplu başlatma listesini TOPTAN reddediyor: tek bir uygunsuz dosya, aynı
 * seçimdeki geçerli videoları da "Başlatılamadı"ya düşürüyordu. Burada elenen
 * dosya yalnızca kendi satırında hata gösterir, istek listesine hiç girmez.
 */
export function fileProblem(file: File): string | null {
  if (!ALLOWED_VIDEO_TYPES[videoType(file)]) return "Bu dosya yüklenemiyor — MP4 ya da MOV video seç";
  if (file.size <= 0) return "Dosya boş görünüyor";
  if (file.size > MAX_VIDEO_BYTES) {
    return `Video en fazla ${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))} MB olabilir`;
  }
  return null;
}

async function requestUploads(
  files: File[]
): Promise<{ ok: true; items: UploadTarget[]; issuedAt: number } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/portal/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files.map((file) => ({ contentType: videoType(file), size: file.size, name: file.name })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "Yükleme başlatılamadı" };
    return { ok: true, items: data.items as UploadTarget[], issuedAt: Date.now() };
  } catch {
    return { ok: false, error: "Bağlantı yok, yükleme başlatılamadı" };
  }
}

/**
 * "Aynı video" kontrolü. Başarısız olursa (ağ, eski sunucu) yükleme
 * DURMAZ: uyarı bir kolaylık, kapı değil — hepsi eşsiz sayılır.
 */
async function checkDuplicates(files: File[]): Promise<(DuplicateMatch | null)[]> {
  const none = () => files.map(() => null);
  try {
    const res = await fetch("/api/portal/upload/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: files.map((file) => ({ size: file.size, name: file.name })) }),
    });
    if (!res.ok) return none();
    const data = (await res.json().catch(() => ({}))) as { matches?: unknown };
    if (!Array.isArray(data.matches) || data.matches.length !== files.length) return none();
    return data.matches as (DuplicateMatch | null)[];
  } catch {
    return none();
  }
}

/**
 * Kare yüklemesi başarısız olabilir; video yine kuyruğa girer. Ama artık
 * sessizce değil: kaç karenin düştüğü `complete` raporuna yazılır. Çok
 * parçalı yolda (`postId` verilince) yeniden deneme taze imzalarla — `parts`
 * route'u `includeFrames` ile aynı kapsam kontrolünden geçmiş URL veriyor.
 */
async function uploadFrames(p: Prepared, urls: string[], multipartPostId?: string): Promise<FramesReport> {
  const freshUrls = multipartPostId
    ? async () => (await requestPartUrls(multipartPostId, [1], { includeFrames: true })).framePutUrls
    : undefined;
  const { failed } = await uploadFrameBlobs(
    p.frames,
    urls,
    (url, body) => putWithProgress(url, body, "image/jpeg"),
    { freshUrls }
  );
  return framesReport(p, failed);
}

function framesReport(p: Prepared, uploadFailed: number): FramesReport {
  const report: FramesReport = { extracted: p.frames.length, uploadFailed };
  if (p.frameError) report.error = p.frameError;
  return report;
}

async function complete(
  postId: string,
  frames: FramesReport,
  parts?: UploadedPart[]
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`/api/portal/videos/${postId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parts ? { parts, frames } : { frames }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.error ?? "Kuyruğa eklenemedi" };
  } catch {
    return { ok: false, status: 0, error: "Bağlantı koptu, kuyruğa eklenemedi" };
  }
}

/** Ekranı açık tut + sayfadan çıkma uyarısı, yalnızca yükleme sürerken. */
function useUploadGuards(active: boolean) {
  useEffect(() => {
    if (!active) return;
    // Tarayıcı kendi standart metnini gösterir; özel metin artık desteklenmiyor.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    // Ekran kilitlenince iOS sayfayı askıya alır ve yükleme durur. Wake Lock
    // iOS 16.4+ Safari'de var; ana ekran uygulamasında daha yeni iOS
    // gerekebilir — yoksa sessizce atlanır. Sayfa gizlenince kilit kendiliğinden
    // bırakılıyor; görünür olunca yeniden alınır.
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        if (sentinel && !sentinel.released) return;
        const next = await navigator.wakeLock.request("screen");
        if (disposed) await next.release();
        else sentinel = next;
      } catch {
        // Desteklenmiyor, izin yok ya da pil tasarrufu — yükleme yine sürer.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

type Work = { p: Prepared; entry?: { target: UploadTarget; issuedAt: number } };

export function useVideoUpload(options: { onFinished?: () => void } = {}) {
  const [items, setItems] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFinished = useRef(options.onFinished);
  onFinished.current = options.onFinished;
  /** Sırayla yüklenecekler; "aynı video"da "Yine de yükle" de buraya eklenir. */
  const workRef = useRef<Work[]>([]);
  /** Kararı sorulan (ya da atlanan) dosyalar — "Geri al" için atlananlar da kalır. */
  const heldRef = useRef(new Map<string, Prepared>());
  /** Hazırlık ya da yükleme sürüyor: karar yalnızca sıraya ekler, sonra işlenir. */
  const busyRef = useRef(false);

  useUploadGuards(running);
  useEffect(() => {
    void pruneResume().catch(() => undefined);
  }, []);

  function patch(key: string, next: Partial<ItemState>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }

  /**
   * Seçim = yükleme: galeriden seçilen videolar ayrıca bir "Yükle" düğmesi
   * beklemeden hemen yüklenmeye başlar. Dosyalar `start`'a state'ten değil
   * doğrudan argümanla gider — `setItems` bu render'da henüz işlenmemiş olur.
   */
  function pick(list: FileList | File[] | null) {
    if (running) return;
    setError(null);
    const picked = Array.from(list ?? []);
    if (picked.length === 0) return;
    if (picked.length > MAX_FILES) {
      setError(`Tek seferde en fazla ${MAX_FILES} video seçebilirsin`);
      return;
    }
    heldRef.current.clear();
    const pickedItems: ItemState[] = picked.map((file, i) => ({
      key: `${i}-${file.name}`,
      name: file.name,
      size: file.size,
      phase: "bekliyor",
      progress: 0,
    }));
    setItems(pickedItems);
    void start(picked.map((file, i) => ({ file, key: pickedItems[i].key })));
  }

  /**
   * Parçaları yükler ve tamamlar. Kayıt (IndexedDB) her parçadan sonra
   * güncellenir: uygulama tam o anda kapansa bile en fazla yoldaki 3 parça
   * yeniden gönderilir.
   */
  async function uploadMultipart(
    p: Prepared,
    record: ResumeRecord,
    initialUrls: Map<number, string> | undefined,
    resumed: boolean,
    frames: FramesReport
  ): Promise<void> {
    patch(p.key, { phase: "yükleniyor", status: resumed ? RESUMED_TEXT : undefined });
    let parts: UploadedPart[];
    try {
      parts = await runMultipartUpload(
        {
          file: p.file,
          partSize: record.partSize,
          done: record.parts,
          initialUrls,
          onProgress: (fraction) => patch(p.key, { progress: fraction }),
          onStatus: (status) =>
            patch(p.key, {
              status: status === "uploading" ? (resumed ? RESUMED_TEXT : undefined) : STATUS_TEXT[status],
            }),
          onPartDone: (_part, all) => {
            record.parts = all;
            record.updatedAt = Date.now();
            void saveResume(record);
          },
        },
        browserMultipartDeps(record.postId)
      );
    } catch (err) {
      if (err instanceof UploadGoneError) {
        await deleteResume(record.key);
        throw new Error("Yükleme süresi doldu, videoyu yeniden seç");
      }
      // Kayıt duruyor: aynı dosya yeniden seçilince bitmiş parçalar atlanır.
      throw new Error(`${(err as Error).message}. ${RESUME_HINT}`);
    }

    patch(p.key, { phase: "tamamlanıyor", progress: 1, status: undefined });
    const done = await complete(record.postId, frames, parts);
    // 409: taslak zaten tamamlanmış (önceki denemenin yanıtı kaybolmuş) — video kuyrukta.
    if (done.ok || done.status === 409) {
      await deleteResume(record.key);
      return;
    }
    // 400: parça listesi tutmuyor ya da dosya sınır dışı — aynı kayıtla
    // yeniden denemek aynı sonucu verir; temiz başlanması için kayıt atılır.
    if (done.status === 400) await deleteResume(record.key);
    throw new Error(done.status === 400 ? done.error : `${done.error}. ${RESUME_HINT}`);
  }

  /**
   * Yarım kalmış yüklemeden devam. Sunucuya ilk soru, sıradaki parçanın
   * imzası: taslak silinmişse / çok parçalı değilse "restart", zaten
   * tamamlanmışsa "done". Kareler yüklenmemişse taze URL'leri de aynı istekte.
   */
  async function resume(p: Prepared, record: ResumeRecord): Promise<"done" | "restart"> {
    patch(p.key, { phase: "yükleniyor", status: RESUMED_TEXT });
    const plan = planParts(p.file.size, record.partSize);
    const left = remainingParts(plan, record.parts);
    const probe = (left[0] ?? plan[plan.length - 1]).partNumber;
    let check: Awaited<ReturnType<typeof requestPartUrls>>;
    try {
      check = await requestPartUrls(record.postId, [probe], { includeFrames: !record.framesDone });
    } catch (err) {
      if (err instanceof UploadGoneError) {
        await deleteResume(record.key);
        return err.status === 409 ? "done" : "restart";
      }
      throw new Error(`${(err as Error).message}. ${RESUME_HINT}`);
    }
    // Kareler önceki oturumda yüklendiyse sonuçları bilinmiyor: düşen yok sayılır.
    let frames = framesReport(p, 0);
    if (!record.framesDone) {
      await retryExtraction(p);
      frames = await uploadFrames(p, check.framePutUrls ?? [], record.postId);
      record.framesDone = true;
      await saveResume(record);
    }
    await uploadMultipart(p, record, left.length ? check.urls : undefined, true, frames);
    return "done";
  }

  /**
   * Seçimde kare çıkarılamadıysa ve neden bir zaman aşımıysa, dosyanın
   * yükleme sırası geldiğinde BİR KEZ daha denenir. Canlıdaki desen: toplu
   * yüklemede yalnızca en son çıkarılan dosyanın karesi vardı, tek başına
   * yüklenen videonun hiç yoktu — çıkarma seçimden bir süre sonra tutuyor
   * gibi. Bu noktada seçici çoktan kapanmış ve sayfa oturmuş olur.
   */
  async function retryExtraction(p: Prepared): Promise<void> {
    if (p.frames.length > 0 || !isRetryableFrameError(p.frameError)) return;
    patch(p.key, { status: "Kareler yeniden deneniyor…" });
    const again = await extractFrames(p.file);
    if (again.frames.length > 0) {
      p.frames = again.frames;
      p.frameError = again.error;
      patch(p.key, { note: undefined, status: undefined, thumb: await toDataUrl(again.frames[0]) });
    } else {
      p.frameError = again.error ?? p.frameError;
      patch(p.key, { status: undefined });
    }
  }

  async function uploadFresh(p: Prepared, target: UploadTarget, issuedAt: number): Promise<void> {
    await retryExtraction(p);
    patch(p.key, { phase: "yükleniyor", progress: 0, status: undefined });
    if (!target.multipart) {
      // Kareler videodan ÖNCE: imzaları toplu istekte alındı ve 15 dk'lık;
      // videodan sonraya bırakmak ömürlerini videonun süresi kadar kısaltırdı.
      // (Tek PUT yolunun taze kare imzası alacağı bir route yok; bu yol yalnızca
      // 16 MB altı dosyalar için, onlar da saniyeler sürüyor.)
      const frames = await uploadFrames(p, target.framePutUrls);
      await putWithProgress(target.videoPutUrl, p.file, videoType(p.file), (fraction) =>
        patch(p.key, { progress: fraction })
      );
      patch(p.key, { phase: "tamamlanıyor", progress: 1 });
      const done = await complete(target.postId, frames);
      if (!done.ok) throw new Error(done.error);
      return;
    }
    const record: ResumeRecord = {
      key: resumeKey(p.file),
      postId: target.postId,
      size: p.file.size,
      partSize: target.partSize,
      parts: [],
      framesDone: false,
      updatedAt: Date.now(),
    };
    await saveResume(record);
    // Kareler ÖNCE: küçükler ve ilk URL'lerin süresi yalnızca 15 dk — video
    // uzun sürerse ya da askıya alınırsa sonraya bırakılan kare URL'leri ölürdü.
    // Toplu yüklemede sıradaki videonun imzaları öncekiler yüklenirken
    // eskiyebilir: 10 dk'dan eskiyse (parça URL'leriyle aynı eşik) kare
    // imzaları ilk parçanınkiyle birlikte tek istekte tazelenir.
    let frameUrls = target.framePutUrls;
    let initialUrls: Map<number, string> | undefined;
    if (p.frames.length > 0 && Date.now() - issuedAt > URL_MAX_AGE_MS) {
      try {
        const fresh = await requestPartUrls(target.postId, [1], { includeFrames: true });
        if (fresh.framePutUrls) frameUrls = fresh.framePutUrls;
        initialUrls = fresh.urls;
      } catch {
        // Tazelenemezse eski imzalarla denenir; düşerse raporda görünür.
      }
    }
    const frames = await uploadFrames(p, frameUrls, target.postId);
    record.framesDone = true;
    await saveResume(record);
    await uploadMultipart(p, record, initialUrls, false, frames);
  }

  /** Tek dosyanın yüklemesi: devam ya da taze taslak, sonra `complete`. */
  async function uploadOne({ p, entry }: Work): Promise<void> {
    try {
      let target = entry;
      if (p.resume) {
        const outcome = await resume(p, p.resume);
        if (outcome === "done") {
          patch(p.key, { phase: "bitti", status: undefined });
          return;
        }
        // Sunucudaki taslak gitmiş: bu dosya için temiz bir taslak.
        target = undefined;
      }
      if (!target) {
        const started = await requestUploads([p.file]);
        if (!started.ok) throw new Error(started.error);
        target = { target: started.items[0], issuedAt: started.issuedAt };
      }
      await uploadFresh(p, target.target, target.issuedAt);
      patch(p.key, { phase: "bitti", status: undefined });
    } catch (err) {
      patch(p.key, { phase: "hata", status: undefined, error: (err as Error).message });
    }
  }

  /** İş listesini sırayla boşaltır; bu arada eklenenler de aynı turda işlenir. */
  async function drain(): Promise<void> {
    busyRef.current = true;
    setRunning(true);
    let uploaded = false;
    try {
      for (let work = workRef.current.shift(); work; work = workRef.current.shift()) {
        await uploadOne(work);
        uploaded = true;
      }
      if (uploaded) onFinished.current?.();
    } finally {
      busyRef.current = false;
      setRunning(false);
    }
  }

  /**
   * "Aynı video" kararı. Yüklenecekse sıraya girer; o an başka yükleme
   * sürüyorsa onun ardından, sürmüyorsa hemen.
   */
  function decide(key: string, upload: boolean) {
    const p = heldRef.current.get(key);
    if (!p) return;
    if (!upload) {
      patch(key, { phase: "atlandı" });
      return;
    }
    heldRef.current.delete(key);
    patch(key, { phase: "bekliyor", duplicate: undefined });
    workRef.current.push({ p });
    if (!busyRef.current) void drain();
  }

  /** Atlanan dosyayı yeniden soruya döndürür. */
  function undoSkip(key: string) {
    if (!heldRef.current.has(key)) return;
    patch(key, { phase: "soruluyor" });
  }

  async function start(picked: { file: File; key: string }[]) {
    busyRef.current = true;
    setRunning(true);
    setError(null);
    try {
      // 1) Ölç + kare çıkar (sırayla — her biri belleğe bir video açıyor).
      const prepared: Prepared[] = [];
      for (const { file, key } of picked) {
        const invalid = fileProblem(file);
        if (invalid) {
          patch(key, { phase: "hata", error: invalid });
          continue;
        }
        patch(key, { phase: "hazırlanıyor" });
        // Süre/yön uymuyorsa kareler hiç çıkarılmaz (bkz. `stopIf`).
        const { probe, frames, error: frameError } = await extractFrames(file, {
          stopIf: (measured) => probeError(measured) !== null,
        });
        const problem = probeError(probe);
        if (problem) {
          patch(key, { phase: "hata", error: problem });
          continue;
        }
        const decision = resumeDecision(await loadResume(resumeKey(file)), file, Date.now());
        const resumeRecord =
          decision.kind === "resume"
            ? {
                key: resumeKey(file),
                postId: decision.postId,
                size: file.size,
                partSize: decision.partSize,
                parts: decision.parts,
                framesDone: decision.framesDone,
                updatedAt: Date.now(),
              }
            : null;
        patch(key, {
          phase: "bekliyor",
          note: frames.length === 0 ? NO_FRAMES_NOTE : undefined,
          status: resumeRecord ? "Yarım kalan yükleme bulundu, kaldığı yerden devam edecek" : undefined,
          thumb: frames[0] ? await toDataUrl(frames[0]) : undefined,
        });
        prepared.push({ file, key, frames, frameError, resume: resumeRecord });
      }
      if (prepared.length === 0) return;

      // 2) "Aynı video" kontrolü — yarım kalanın devamı sorulmaz (o zaten
      //    bu dosyanın kendi taslağı).
      const fresh = prepared.filter((p) => !p.resume);
      const matches = fresh.length > 0 ? await checkDuplicates(fresh.map((p) => p.file)) : [];
      fresh.forEach((p, i) => {
        const match = matches[i];
        if (!match) return;
        heldRef.current.set(p.key, p);
        patch(p.key, { phase: "soruluyor", duplicate: match, status: undefined });
      });

      // 3) Kalanların taslakları, tek istekte.
      const go = fresh.filter((p) => !heldRef.current.has(p.key));
      const targets = new Map<string, Work["entry"]>();
      if (go.length > 0) {
        const started = await requestUploads(go.map((p) => p.file));
        if (!started.ok) {
          setError(started.error);
          for (const p of go) patch(p.key, { phase: "hata", error: "Başlatılamadı" });
        } else {
          go.forEach((p, i) => targets.set(p.key, { target: started.items[i], issuedAt: started.issuedAt }));
        }
      }
      for (const p of prepared) {
        if (p.resume) workRef.current.push({ p });
        else if (targets.has(p.key)) workRef.current.push({ p, entry: targets.get(p.key) });
      }
    } finally {
      // 4) Sırayla yükle + tamamla (`decide` ile eklenenler dahil).
      await drain();
    }
  }

  const doneCount = items.filter((i) => i.phase === "bitti").length;
  return { items, running, error, doneCount, pick, decide, undoSkip };
}
