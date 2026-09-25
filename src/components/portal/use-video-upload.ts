"use client";

import { useEffect, useRef, useState } from "react";
import { extractFrames, probeError, putWithProgress } from "@/lib/frames-client";
import {
  planParts,
  remainingParts,
  requestPartUrls,
  resumeDecision,
  resumeKey,
  runMultipartUpload,
  browserMultipartDeps,
  UploadGoneError,
  type MultipartStatus,
  type ResumeRecord,
  type UploadedPart,
} from "@/lib/multipart-client";
import { deleteResume, loadResume, pruneResume, saveResume } from "@/lib/upload-resume-store";

/**
 * Video kuyruğu — yükleme akışının MANTIĞI (README §7, V7b). Görünüm
 * `upload-form.tsx`'te; mobil arayüz yeniden tasarlandığında bu hook olduğu
 * gibi bağlanabilsin diye ayrı.
 *
 *   1. Her dosya tarayıcıda ölçülür (≤ 90 sn, dikey) ve 6 kare çıkarılır.
 *   2. Aynı dosya için yarım kalmış bir çok parçalı yükleme kaydı varsa
 *      (IndexedDB) o taslaktan devam edilir; yoksa geçen dosyalar için TEK
 *      istekte taslak + yükleme bilgisi alınır.
 *   3. Küçük video tek PUT'la, büyük video parça parça R2'ye gider.
 *   4. `complete` dosyanın gerçekten yüklendiğini doğrular ve kuyruğa ekler.
 *
 * Videolar SIRAYLA yüklenir: telefonda paralel 300 MB'lık yüklemeler bant
 * genişliğini bölüp hepsini yavaşlatır, biri koptuğunda da hangisinin
 * bittiği belirsizleşir. (Parçalar ise video İÇİNDE 3'erli paralel.)
 */

export type ItemPhase = "bekliyor" | "hazırlanıyor" | "yükleniyor" | "tamamlanıyor" | "bitti" | "hata";

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
};

type UploadTarget =
  | { postId: string; multipart: false; videoPutUrl: string; framePutUrls: string[] }
  | { postId: string; multipart: true; partSize: number; framePutUrls: string[] };

type Prepared = { file: File; key: string; frames: Blob[]; resume: ResumeRecord | null };

export const MAX_FILES = 20;

/** Dışa açık: görünüm "bekleyen" durumları (turuncu kart) bu metinlerle ayırt ediyor. */
export const STATUS_TEXT: Record<Exclude<MultipartStatus, "uploading">, string> = {
  "waiting-network": "Bağlantı bekleniyor",
  "waiting-visible": "Uygulamaya dönünce devam eder",
  retrying: "Bağlantı koptu, yeniden deneniyor",
};
const RESUMED_TEXT = "Devam ediyor…";
const RESUME_HINT = "Aynı videoyu yeniden seçersen kaldığı yerden devam eder";

/**
 * Bazı tarayıcılar (.mov'da Windows Chrome'u gibi) `file.type`'ı boş verir.
 * Uzantıdan tamamlanıyor; imzalı PUT'un tipi de AYNI fonksiyondan gelmeli,
 * yoksa R2 imza uyuşmazlığıyla 403 döner.
 */
export function videoType(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".mp4")) return "video/mp4";
  return "";
}

async function requestUploads(
  files: File[]
): Promise<{ ok: true; items: UploadTarget[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/portal/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files.map((file) => ({ contentType: videoType(file), size: file.size })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "Yükleme başlatılamadı" };
    return { ok: true, items: data.items as UploadTarget[] };
  } catch {
    return { ok: false, error: "Bağlantı yok, yükleme başlatılamadı" };
  }
}

/** Kare yüklemesi başarısız olabilir; video yine kuyruğa girer. */
async function uploadFrames(frames: Blob[], urls: string[]): Promise<void> {
  await Promise.all(
    frames.map((frame, n) =>
      urls[n] ? putWithProgress(urls[n], frame, "image/jpeg").catch(() => undefined) : undefined
    )
  );
}

async function complete(
  postId: string,
  parts?: UploadedPart[]
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`/api/portal/videos/${postId}/complete`, {
      method: "POST",
      headers: parts ? { "Content-Type": "application/json" } : undefined,
      body: parts ? JSON.stringify({ parts }) : undefined,
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

export function useVideoUpload(options: { onFinished?: () => void } = {}) {
  const [files, setFiles] = useState<File[]>([]);
  const [items, setItems] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFinished = useRef(options.onFinished);
  onFinished.current = options.onFinished;

  useUploadGuards(running);
  useEffect(() => {
    void pruneResume().catch(() => undefined);
  }, []);

  function patch(key: string, next: Partial<ItemState>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }

  function pick(list: FileList | File[] | null) {
    setError(null);
    const picked = Array.from(list ?? []);
    if (picked.length > MAX_FILES) {
      setError(`Tek seferde en fazla ${MAX_FILES} video seçebilirsin`);
      return;
    }
    setFiles(picked);
    setItems(
      picked.map((file, i) => ({
        key: `${i}-${file.name}`,
        name: file.name,
        size: file.size,
        phase: "bekliyor",
        progress: 0,
      }))
    );
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
    resumed: boolean
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
    const done = await complete(record.postId, parts);
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
    if (!record.framesDone) {
      if (check.framePutUrls) await uploadFrames(p.frames, check.framePutUrls);
      record.framesDone = true;
      await saveResume(record);
    }
    await uploadMultipart(p, record, left.length ? check.urls : undefined, true);
    return "done";
  }

  async function uploadFresh(p: Prepared, target: UploadTarget): Promise<void> {
    patch(p.key, { phase: "yükleniyor", progress: 0, status: undefined });
    if (!target.multipart) {
      await putWithProgress(target.videoPutUrl, p.file, videoType(p.file), (fraction) =>
        patch(p.key, { progress: fraction })
      );
      await uploadFrames(p.frames, target.framePutUrls);
      patch(p.key, { phase: "tamamlanıyor", progress: 1 });
      const done = await complete(target.postId);
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
    await uploadFrames(p.frames, target.framePutUrls);
    record.framesDone = true;
    await saveResume(record);
    await uploadMultipart(p, record, undefined, false);
  }

  async function start() {
    if (running || files.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      // 1) Ölç + kare çıkar (sırayla — her biri belleğe bir video açıyor).
      const prepared: Prepared[] = [];
      for (const [i, file] of files.entries()) {
        const key = items[i].key;
        patch(key, { phase: "hazırlanıyor" });
        const { probe, frames } = await extractFrames(file);
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
          note: frames.length === 0 ? "Kare çıkarılamadı; caption yalnızca sesten üretilecek" : undefined,
          status: resumeRecord ? "Yarım kalan yükleme bulundu, kaldığı yerden devam edecek" : undefined,
        });
        prepared.push({ file, key, frames, resume: resumeRecord });
      }
      if (prepared.length === 0) return;

      // 2) Devam edilmeyecek dosyalar için taslaklar, tek istekte.
      const fresh = prepared.filter((p) => !p.resume);
      const targets = new Map<string, UploadTarget>();
      if (fresh.length > 0) {
        const started = await requestUploads(fresh.map((p) => p.file));
        if (!started.ok) {
          setError(started.error);
          for (const p of fresh) patch(p.key, { phase: "hata", error: "Başlatılamadı" });
        } else {
          fresh.forEach((p, i) => targets.set(p.key, started.items[i]));
        }
      }

      // 3–4) Sırayla yükle + tamamla.
      for (const p of prepared) {
        try {
          if (p.resume) {
            const outcome = await resume(p, p.resume);
            if (outcome === "done") {
              patch(p.key, { phase: "bitti", status: undefined });
              continue;
            }
            // Sunucudaki taslak gitmiş: bu dosya için temiz bir taslak.
            const started = await requestUploads([p.file]);
            if (!started.ok) throw new Error(started.error);
            targets.set(p.key, started.items[0]);
          }
          const target = targets.get(p.key);
          if (!target) continue;
          await uploadFresh(p, target);
          patch(p.key, { phase: "bitti", status: undefined });
        } catch (err) {
          patch(p.key, { phase: "hata", status: undefined, error: (err as Error).message });
        }
      }
      onFinished.current?.();
    } finally {
      setRunning(false);
    }
  }

  const doneCount = items.filter((i) => i.phase === "bitti").length;
  return { files, items, running, error, doneCount, pick, start };
}
