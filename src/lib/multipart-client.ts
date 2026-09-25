/**
 * Video kuyruğu (V7b) — tarayıcıda çok parçalı (kaldığı yerden devam eden)
 * yükleme. Tasarım: docs/video-kuyrugu/V7-pwa.md §5.
 *
 * Sorun: iOS arka plana atılan sayfayı askıya alıyor; 150 MB'lık tek PUT
 * yarıda kalınca baştan başlıyordu. Burada dosya `partSize`'lık parçalara
 * bölünür, her parça ayrı bir imzalı PUT'la doğrudan R2'ye gider; kopan parça
 * tek başına yeniden denenir, bitenler bir daha gönderilmez.
 *
 * Çekirdek (`createMultipartUploader` ve saf yardımcılar) DOM'a dokunmaz —
 * ağ, zamanlayıcı ve "sayfa görünür mü / çevrimiçi mi" bağımlılık olarak
 * verilir; birim testleri bunları sahteleyerek koşuyor. Tarayıcı bağımlılıkları
 * dosyanın sonunda (`browserMultipartDeps`), React'e hiç bağlı değil: mobil
 * arayüz yeniden tasarlandığında bu modül olduğu gibi kalır.
 */

export type UploadedPart = { partNumber: number; etag: string };
export type PartRange = { partNumber: number; start: number; end: number };

/** Aynı anda gönderilen parça sayısı: telefonda bant genişliğini doyurur, bölmez. */
export const DEFAULT_CONCURRENCY = 3;
/** Parça başına deneme hakkı. Sayfa gizli/çevrimdışıyken düşen denemeler sayılmaz. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * İmzalı URL'ler sunucuda 15 dk geçerli; 10 dk'dan eski URL kullanılmaz,
 * yenisi istenir. Aradaki pay, yavaş bağlantıda parçanın yolda geçen süresi.
 */
export const URL_MAX_AGE_MS = 10 * 60 * 1000;
/** Sunucunun tek istekte imzaladığı en fazla parça (portal-validation `MAX_PARTS_PER_SIGN`). */
export const SIGN_BATCH = 20;
/**
 * Kaldığı yerden devam için üst sınır. Sunucu 24 saatlik taslağı siliyor
 * (draft-cleanup `STALE_DRAFT_MS`); daha eski bir kayıtla sunucuya sormak
 * boşuna bir istek.
 */
export const RESUME_MAX_AGE_MS = 23 * 60 * 60 * 1000;

// ─── Saf yardımcılar ─────────────────────────────────────────────────────

/** Dosyayı 1'den numaralı parçalara böler; son parça kısa kalabilir. */
export function planParts(size: number, partSize: number): PartRange[] {
  if (!Number.isInteger(partSize) || partSize <= 0) throw new Error("Geçersiz parça boyutu");
  if (!Number.isFinite(size) || size <= 0) return [];
  const parts: PartRange[] = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(start + partSize, size) });
  }
  return parts;
}

/** Plandan henüz yüklenmemiş parçalar, sırayla. */
export function remainingParts(plan: PartRange[], done: UploadedPart[]): PartRange[] {
  const finished = new Set(done.map((part) => part.partNumber));
  return plan.filter((part) => !finished.has(part.partNumber));
}

/**
 * Üstel geri çekilme, "eşit jitter"le: 1, 2, 4, 8… sn'nin yarısı sabit, yarısı
 * rastgele. Rastgelelik aynı anda kopan üç parçanın aynı saniyede yeniden
 * çarpışmasını dağıtıyor; sabit yarı ise beklemenin sıfıra düşmesini önlüyor.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {}
): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export type ResumeRecord = {
  /** `resumeKey(file)` */
  key: string;
  postId: string;
  size: number;
  partSize: number;
  parts: UploadedPart[];
  /** Kareler yüklendi mi — devam ederken yeniden imzalatmak gerekip gerekmediği. */
  framesDone: boolean;
  updatedAt: number;
};

/**
 * Dosyanın kimliği. iOS'ta `File` nesnesi sayfa kapanınca kayboluyor ve
 * dosyaya kalıcı erişim yok; kullanıcı aynı videoyu yeniden seçtiğinde onu
 * tanımanın elde kalan yolu ad + boyut + son değişiklik zamanı.
 */
export function resumeKey(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/**
 * Kayıttan devam edilebilir mi? Etmiyorsa taze yükleme başlar. Burada
 * yalnızca YEREL tutarlılık bakılıyor; taslağın sunucuda hâlâ `draft` olup
 * olmadığını ilk parça imzası söyler (404/409/400 → temiz başla).
 */
export function resumeDecision(
  record: ResumeRecord | null | undefined,
  file: { name: string; size: number; lastModified: number },
  now: number
):
  | { kind: "fresh"; reason: "none" | "mismatch" | "stale" }
  | { kind: "resume"; postId: string; partSize: number; parts: UploadedPart[]; framesDone: boolean } {
  if (!record) return { kind: "fresh", reason: "none" };
  if (
    record.key !== resumeKey(file) ||
    record.size !== file.size ||
    !Number.isInteger(record.partSize) ||
    record.partSize <= 0 ||
    typeof record.postId !== "string" ||
    !Array.isArray(record.parts)
  ) {
    return { kind: "fresh", reason: "mismatch" };
  }
  if (now - record.updatedAt > RESUME_MAX_AGE_MS) return { kind: "fresh", reason: "stale" };
  const total = planParts(file.size, record.partSize).length;
  // Plana uymayan (bozuk ya da başka bir parça boyutundan kalma) parçalar atılır.
  const parts = record.parts.filter(
    (part) =>
      Number.isInteger(part?.partNumber) &&
      part.partNumber >= 1 &&
      part.partNumber <= total &&
      typeof part.etag === "string" &&
      part.etag.length > 0
  );
  return {
    kind: "resume",
    postId: record.postId,
    partSize: record.partSize,
    parts,
    framesDone: record.framesDone === true,
  };
}

// ─── Hatalar ─────────────────────────────────────────────────────────────

/**
 * Sunucudaki yükleme artık yok ya da devam edilemez (taslak silinmiş: 404,
 * zaten tamamlanmış: 409, çok parçalı değil: 400, R2'de iptal edilmiş: 404).
 * Tekrar denemek anlamsız; çağıran taraf temiz başlar (409'da videoyu
 * kuyrukta sayar).
 */
export class UploadGoneError extends Error {
  constructor(public status: number, message = "Yükleme artık geçerli değil") {
    super(message);
    this.name = "UploadGoneError";
  }
}

/** Yeniden denemenin çözmeyeceği hata (oturum düştü, CORS ETag'i vermiyor…). */
export class FatalUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalUploadError";
  }
}

/** Parça PUT'unun HTTP hatası; `status` 0 = ağ hatası / zaman aşımı. */
export class PartPutError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PartPutError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("İptal edildi");
    this.name = "AbortedError";
  }
}

// ─── Çekirdek ────────────────────────────────────────────────────────────

export type Readiness = "ready" | "offline" | "hidden";
export type MultipartStatus = "uploading" | "retrying" | "waiting-network" | "waiting-visible";

export type MultipartDeps = {
  /** Parça numaraları → imzalı URL. Kalıcı hatada `UploadGoneError`/`FatalUploadError` fırlatır. */
  signParts(partNumbers: number[]): Promise<Map<number, string>>;
  /** Parçayı PUT eder, R2'nin `ETag`'ini döner. */
  putPart(
    url: string,
    body: Blob,
    opts: { signal: AbortSignal; onProgress: (loaded: number) => void }
  ): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  readiness(): Readiness;
  /** Hazır olunca (görünür + çevrimiçi) çözülür. */
  waitUntilReady(): Promise<void>;
  /**
   * "Durum değişti, hemen dene" sinyali (`online`, sayfa yeniden görünür).
   * Geri çekilme beklemesini keser ve takılmış görünen istekleri iptal
   * ettirir. Aboneliği kaldıran fonksiyonu döner.
   */
  onWake(listener: () => void): () => void;
};

export type MultipartOptions = {
  file: Blob;
  partSize: number;
  /** Önceki oturumdan kalan tamamlanmış parçalar (kaldığı yerden devam). */
  done?: UploadedPart[];
  /** Önceden alınmış taze URL'ler (ör. devam kontrolündeki ilk imza). */
  initialUrls?: Map<number, string>;
  concurrency?: number;
  maxAttempts?: number;
  /** Uyanma sinyalinde bu süredir ilerleme vermeyen istek takılmış sayılıp kesilir. */
  stallMs?: number;
  onPartDone?(part: UploadedPart, all: UploadedPart[]): void;
  onProgress?(fraction: number): void;
  onStatus?(status: MultipartStatus): void;
  random?: () => number;
};

type InFlight = { controller: AbortController; lastProgressAt: number; interrupted: boolean };

/**
 * Parçaları `concurrency` işçiyle yükler; bittiğinde sıralı parça listesini
 * (tamamlama isteğinin gövdesi) döner. İlk kalıcı hatada bütün işçiler durur
 * ve yoldaki istekler iptal edilir.
 */
export async function runMultipartUpload(
  options: MultipartOptions,
  deps: MultipartDeps
): Promise<UploadedPart[]> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stallMs = options.stallMs ?? 10_000;
  const plan = planParts(options.file.size, options.partSize);
  const total = options.file.size;

  const done = new Map<number, string>();
  for (const part of options.done ?? []) done.set(part.partNumber, part.etag);
  const queue = remainingParts(plan, options.done ?? []);
  const sizeOf = new Map(plan.map((p) => [p.partNumber, p.end - p.start]));
  let doneBytes = [...done.keys()].reduce((sum, n) => sum + (sizeOf.get(n) ?? 0), 0);

  const urls = new Map<number, { url: string; at: number }>();
  for (const [n, url] of options.initialUrls ?? []) urls.set(n, { url, at: deps.now() });

  const inFlight = new Map<number, InFlight>();
  /** İşçilerin üstlendiği parçalar — iki işçi aynı parçayı almasın. */
  const claimed = new Set<number>();
  const sortedDone = (): UploadedPart[] =>
    [...done]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
  const loaded = new Map<number, number>();
  const stop = new AbortController();
  let failure: unknown = null;
  let signing: Promise<void> | null = null;
  let wakeSleepers: (() => void)[] = [];

  const report = () =>
    options.onProgress?.(
      total > 0 ? Math.min(1, (doneBytes + [...loaded.values()].reduce((a, b) => a + b, 0)) / total) : 1
    );

  const unsubscribe = deps.onWake(() => {
    // Takılmış istekleri kes (askıdan dönen sayfada soket ölü olabilir ama
    // XHR bunu hiç bildirmeyebilir); ilerleyenlere dokunma — masaüstünde
    // sekme değiştirmek sağlıklı bir yüklemeyi boşa göndermesin.
    const now = deps.now();
    for (const flight of inFlight.values()) {
      if (now - flight.lastProgressAt >= stallMs) {
        flight.interrupted = true;
        flight.controller.abort();
      }
    }
    const sleepers = wakeSleepers;
    wakeSleepers = [];
    for (const wake of sleepers) wake();
  });

  /** Durdurma sinyaliyle yarışan bekleme: iptal edilen yükleme askıda kalmasın. */
  const untilStopped = (promise: Promise<void>) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        stop.signal.removeEventListener("abort", finish);
        resolve();
      };
      stop.signal.addEventListener("abort", finish, { once: true });
      void promise.then(finish, finish);
    });

  /** Geri çekilme beklemesi; uyanma sinyali ya da durdurma kısa keser. */
  const pause = (ms: number) =>
    untilStopped(
      new Promise<void>((resolve) => {
        wakeSleepers.push(resolve);
        void deps.sleep(ms).then(() => resolve());
      })
    );

  async function gate(): Promise<void> {
    let state = deps.readiness();
    while (state !== "ready") {
      options.onStatus?.(state === "offline" ? "waiting-network" : "waiting-visible");
      await untilStopped(deps.waitUntilReady());
      if (stop.signal.aborted) throw new AbortedError();
      state = deps.readiness();
    }
  }

  /** Parçanın taze URL'i; yoksa sıradaki imzasız parçalarla birlikte toplu ister. */
  async function urlFor(partNumber: number): Promise<string> {
    for (;;) {
      const cached = urls.get(partNumber);
      if (cached && deps.now() - cached.at < URL_MAX_AGE_MS) return cached.url;
      if (signing) {
        // Başka bir işçi zaten imza istiyor; aynı parçaları iki kez istemeyelim.
        await signing.catch(() => undefined);
        continue;
      }
      const now = deps.now();
      const wanted = [
        partNumber,
        ...queue
          .map((p) => p.partNumber)
          .filter((n) => n !== partNumber && !done.has(n) && !inFlight.has(n))
          .filter((n) => {
            const c = urls.get(n);
            return !c || now - c.at >= URL_MAX_AGE_MS;
          }),
      ].slice(0, SIGN_BATCH);
      signing = deps.signParts(wanted).then((signed) => {
        const at = deps.now();
        for (const [n, url] of signed) urls.set(n, { url, at });
      });
      try {
        await signing;
      } finally {
        signing = null;
      }
      if (!urls.has(partNumber)) throw new FatalUploadError("Sunucu parça imzası döndürmedi");
    }
  }

  async function uploadPart(range: PartRange): Promise<void> {
    let attempts = 0;
    for (;;) {
      if (stop.signal.aborted) throw new AbortedError();
      await gate();
      const flight: InFlight = {
        controller: new AbortController(),
        lastProgressAt: deps.now(),
        interrupted: false,
      };
      const onStop = () => flight.controller.abort();
      stop.signal.addEventListener("abort", onStop, { once: true });
      try {
        const url = await urlFor(range.partNumber);
        inFlight.set(range.partNumber, flight);
        const etag = await deps.putPart(url, options.file.slice(range.start, range.end), {
          signal: flight.controller.signal,
          onProgress: (bytes) => {
            flight.lastProgressAt = deps.now();
            loaded.set(range.partNumber, bytes);
            report();
          },
        });
        done.set(range.partNumber, etag);
        loaded.delete(range.partNumber);
        doneBytes += range.end - range.start;
        report();
        options.onStatus?.("uploading");
        options.onPartDone?.({ partNumber: range.partNumber, etag }, sortedDone());
        return;
      } catch (error) {
        loaded.delete(range.partNumber);
        report();
        if (stop.signal.aborted) throw new AbortedError();
        if (error instanceof UploadGoneError || error instanceof FatalUploadError) throw error;
        // R2'de yükleme iptal edilmiş (temizlik ya da lifecycle): parça PUT'u
        // `NoSuchUpload` ile 404 döner. Tekrar denemek boşuna.
        if (error instanceof PartPutError && error.status === 404) {
          throw new UploadGoneError(404, "Yükleme depolamada artık yok");
        }
        // Uyanma sinyaliyle kesilen ya da sayfa gizli/çevrimdışıyken düşen
        // deneme hak yemez: kopmanın sebebi ağ değil, işletim sistemi.
        if (flight.interrupted || deps.readiness() !== "ready") continue;
        // 403: imzanın süresi dolmuş olabilir (uzun askı) — URL'i at, yenisini iste.
        if (error instanceof PartPutError && error.status === 403) urls.delete(range.partNumber);
        attempts += 1;
        if (attempts >= maxAttempts) throw error;
        options.onStatus?.("retrying");
        await pause(backoffDelay(attempts, { random: options.random }));
      } finally {
        inFlight.delete(range.partNumber);
        stop.signal.removeEventListener("abort", onStop);
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (stop.signal.aborted) return;
      const next = queue.find((p) => !claimed.has(p.partNumber));
      if (!next) return;
      claimed.add(next.partNumber);
      try {
        await uploadPart(next);
      } catch (error) {
        if (!failure && !(error instanceof AbortedError)) failure = error;
        stop.abort();
        return;
      }
    }
  }
  try {
    report();
    options.onStatus?.("uploading");
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    if (failure) throw failure;
    if (stop.signal.aborted) throw new AbortedError();
    return sortedDone();
  } finally {
    stop.abort();
    unsubscribe();
  }
}

// ─── Tarayıcı bağımlılıkları ─────────────────────────────────────────────

/**
 * Sayfanın görünürlüğü ve bağlantısı. iOS arka plandaki sayfayı askıya
 * alıyor; askıdayken düşen istekler "ağ hatası" gibi görünür ama sebebi ağ
 * değil — görünür olana kadar beklemek, deneme hakkını boşa yakmaktan iyi.
 */
export function browserReadiness(): Pick<MultipartDeps, "readiness" | "waitUntilReady" | "onWake"> {
  const readiness = (): Readiness => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return "hidden";
    return "ready";
  };
  const onWake = (listener: () => void) => {
    const onVisible = () => {
      if (document.visibilityState === "visible") listener();
    };
    window.addEventListener("online", listener);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", listener);
      document.removeEventListener("visibilitychange", onVisible);
    };
  };
  const waitUntilReady = () =>
    new Promise<void>((resolve) => {
      if (readiness() === "ready") return resolve();
      const off = onWake(() => {
        if (readiness() !== "ready") return;
        off();
        resolve();
      });
    });
  return { readiness, waitUntilReady, onWake };
}

/**
 * Parça PUT'u, XHR ile (fetch yükleme ilerlemesi vermiyor). `ETag` yanıt
 * başlığı R2 CORS'unda `ExposeHeaders`'a açık; okunamıyorsa CORS ayarı
 * bozulmuştur — tekrar denemek çözmez.
 *
 * `timeoutMs` boyunca hiç ilerleme olmazsa istek kesilir: askıdan dönen
 * sayfada ölü soket XHR'ı sonsuza kadar bekletebiliyor.
 */
export function xhrPutPart(timeoutMs = 45_000): MultipartDeps["putPart"] {
  return (url, body, { signal, onProgress }) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new AbortedError());
      const xhr = new XMLHttpRequest();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => xhr.abort(), timeoutMs);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => xhr.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      xhr.open("PUT", url);
      xhr.upload.onprogress = (event) => {
        arm();
        onProgress(event.loaded);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status < 200 || xhr.status >= 300) {
          return reject(new PartPutError(xhr.status, `Parça reddedildi (${xhr.status})`));
        }
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) return reject(new FatalUploadError("Depolama parça kimliğini (ETag) vermedi"));
        resolve(etag);
      };
      xhr.onerror = () => {
        cleanup();
        reject(new PartPutError(0, "Bağlantı koptu"));
      };
      xhr.onabort = () => {
        cleanup();
        reject(signal.aborted ? new AbortedError() : new PartPutError(0, "Parça zaman aşımına uğradı"));
      };
      arm();
      xhr.send(body);
    });
}

/**
 * Sunucudan parça imzası. 404/409/400 kalıcı ("bu yükleme artık yok"), 401
 * oturum düşmüş; 429/5xx/ağ hatası geçici — çekirdek geri çekilip yeniden dener.
 */
export async function requestPartUrls(
  postId: string,
  partNumbers: number[],
  opts: { includeFrames?: boolean } = {}
): Promise<{ urls: Map<number, string>; framePutUrls?: string[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/portal/videos/${postId}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partNumbers, includeFrames: opts.includeFrames || undefined }),
    });
  } catch {
    throw new PartPutError(0, "Bağlantı koptu");
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    parts?: { partNumber: number; url: string }[];
    framePutUrls?: string[];
  };
  if (res.status === 404 || res.status === 409 || res.status === 400) {
    throw new UploadGoneError(res.status, data.error);
  }
  if (res.status === 401) throw new FatalUploadError("Oturumun sona erdi, yeniden giriş yap");
  if (!res.ok) throw new PartPutError(res.status, data.error ?? `Parça imzası alınamadı (${res.status})`);
  return {
    urls: new Map((data.parts ?? []).map((p) => [p.partNumber, p.url])),
    framePutUrls: data.framePutUrls,
  };
}

export function browserMultipartDeps(postId: string): MultipartDeps {
  return {
    signParts: async (partNumbers) => (await requestPartUrls(postId, partNumbers)).urls,
    putPart: xhrPutPart(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...browserReadiness(),
  };
}
