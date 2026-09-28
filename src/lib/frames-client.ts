/**
 * Video kuyruğu (V3) — tarayıcıda kare çıkarma ve doğrudan R2 yüklemesi.
 *
 * Sunucuda ffmpeg yok (K1, K11): konuşmasız videoların (kâğıda yazı yazılan
 * videolar gibi) caption'ı için görsel bağlam tarayıcıda, `<video>` + `canvas`
 * ile 6 kare olarak alınıyor. Kareler JPEG, en fazla 720 px genişlik — Claude'a
 * gidecek bağlam için yeterli, R2'de ve yüklemede ucuz.
 *
 * Yalnızca TARAYICIDA çalışır (DOM API'leri); sunucu kodundan import etme.
 */

export const FRAME_COUNT = 6;
export const FRAME_MAX_WIDTH = 720;
/** README §7: Reels sınırı. Sunucu süreyi ölçemez (video işlenmiyor), kapı burası. */
export const MAX_DURATION_SEC = 90;

export type VideoProbe = { duration: number; width: number; height: number };

/**
 * Kare çıkarma neden başarısız oldu — `complete` gövdesiyle sunucuya gider ve
 * karesiz kalan video için operatöre uyarı olarak düşer. Canlıda (2026-09-28)
 * portal videolarının çoğu karesiz kaldı; istemci bunu sessizce yuttuğu için
 * nedeni hiçbir yerde görünmedi. Bu kodlar o körlüğü kapatmak için.
 */
export type FrameErrorCode =
  | "metadata-timeout" // `loadedmetadata` hiç gelmedi (yükleme izni yok / dosya okunamıyor)
  | "loadeddata-timeout" // süre ölçüldü ama ilk kare hiç çözülmedi, sarma da tutmadı
  | "seek-timeout" // `seeked` yeniden denemeye rağmen gelmedi
  | "decode" // `<video>` `error` verdi (codec açılamıyor)
  | "bad-metadata" // süre/boyut okunamadı (Infinity, 0)
  | "no-canvas" // 2d bağlam alınamadı
  | "encode" // `toBlob` boş döndü
  | "unknown";

export type FrameExtraction = {
  probe: VideoProbe | null;
  frames: Blob[];
  /** Bir adım takıldıysa dolu; kısmi başarıda (ör. 4/6 kare) da dolu olabilir. */
  error?: FrameErrorCode;
};

/**
 * Yeniden denemeye değer hatalar: zaman aşımları. Canlıdaki desen (toplu
 * yüklemede yalnızca SON dosyanın karesi var, tek video hiç yok) çıkarmanın
 * seçimden hemen sonra takılıp biraz sonra tuttuğunu düşündürüyor; codec
 * hatası ya da okunamayan süre ise ikinci denemede de aynı kalır.
 */
export function isRetryableFrameError(error: FrameErrorCode | undefined): boolean {
  return error === "metadata-timeout" || error === "loadeddata-timeout" || error === "seek-timeout";
}

/** Aralıkların ORTASI: 0. saniye çoğu videoda siyah/geçiş karesi. */
export function frameTimes(duration: number, count: number = FRAME_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
}

class FrameStepError extends Error {
  constructor(readonly code: FrameErrorCode) {
    super(code);
  }
}

const TIMEOUT_CODE: Record<string, FrameErrorCode> = {
  loadedmetadata: "metadata-timeout",
  loadeddata: "loadeddata-timeout",
  seeked: "seek-timeout",
};

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new FrameStepError(TIMEOUT_CODE[event] ?? "unknown"));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new FrameStepError("decode"));
    };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener("error", fail);
    }
    target.addEventListener(event, ok);
    target.addEventListener("error", fail);
  });
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8));
}

/**
 * Galeri seçicisi kapanırken sayfa bir an görünmez olabiliyor (iOS ana ekran
 * uygulaması). Görünmez sayfada WebKit medya yüklemesini askıya alıyor; çıkarma
 * sayfa görünür olunca başlar. Sonsuza dek beklenmez — kullanıcı uygulamadan
 * çıktıysa zaman aşımları durumu zaten raporlar.
 */
function whenVisible(timeoutMs: number): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState !== "hidden") done();
    };
    const timer = setTimeout(done, timeoutMs);
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * Çözücüyü uyandırır: iOS hiç oynatılmamış bir öğede yalnızca metadata'yı
 * yükleyip kareyi çözmeyebiliyor. `play()` sözü izin yoksa reddediliyor ama
 * bazı durumlarda hiç sonuçlanmayabiliyor; kare çıkarma buna rehin kalmasın
 * diye süreli.
 */
async function nudgeDecoder(video: HTMLVideoElement): Promise<void> {
  try {
    const played = video.play() as Promise<void> | undefined;
    if (played && typeof played.then === "function") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        played.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
      clearTimeout(timer);
    }
  } catch {
    // Eski motorlar `play()`'de senkron fırlatabiliyor; uyandırma isteğe bağlı.
  }
  try {
    video.pause();
  } catch {
    // Aynı gerekçe.
  }
}

/**
 * Tek bir kareye sar. Zaman aşımında BİR KEZ yeniden denenir: iOS ilk seek
 * isteğini, çözücü henüz hazır değilken sessizce düşürebiliyor. Aynı değeri
 * yeniden atamak bazı motorlarda yeni seek başlatmadığı için ikinci deneme
 * çok küçük bir kaydırmayla.
 */
async function seekTo(video: HTMLVideoElement, time: number, timeoutMs: number): Promise<void> {
  video.currentTime = time;
  try {
    await once(video, "seeked", timeoutMs);
  } catch (error) {
    if (!(error instanceof FrameStepError) || error.code !== "seek-timeout") throw error;
    video.currentTime = Math.max(0, time - 0.01);
    await once(video, "seeked", timeoutMs);
  }
}

/**
 * 1 px'lik görünmez kutu. Ekran DIŞINA (left:-9999px) değil, ekranın içine:
 * WebKit'in görünürlük sezgileri görünür alan dışındaki videonun oynatılmasını
 * durdurabiliyor; `opacity` ise o hesaba girmiyor.
 */
const HIDDEN_VIDEO_STYLE =
  "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1";

/**
 * Videonun süresini/boyutunu ölçer ve kareleri çıkarır.
 *
 * Kare çıkarma başarısız olursa (tarayıcı codec'i açamıyor — ör. masaüstü
 * Chrome'da bazı HEVC .mov dosyaları) HATA FIRLATMAZ: kareler boş, `error`
 * dolu döner. Video yine yüklenir; caption yalnızca transkriptle üretilir.
 * Kare yüzünden yüklemeyi engellemek, kullanıcının asıl işini (videoyu kuyruğa
 * koymak) ikincil bir özelliğe rehin etmek olurdu. Süre ölçüldüyse `probe`
 * sonraki adımlar takılsa bile döner — 90 sn / dikey kapısı karelere bağlı
 * değil.
 *
 * iOS sağlamlaştırması (canlıda 19 portal videosunun yalnızca 4'ünde kare
 * vardı): WebKit DOM'a bağlı olmayan, hiç oynatılmamış bir `<video>`'da
 * `preload`'ı yok sayıp kare verisini yüklemeyebiliyor; o zaman `seeked`
 * gelmiyor. Bu yüzden öğe görünmez bir kutuyla DOM'a ekleniyor, sessiz +
 * satır içi `play()/pause()` ile çözücü uyandırılıyor ve ilk kare
 * (`loadeddata`) beklenip öyle sarılıyor.
 *
 * `stopIf`: süre/boyut ölçülür ölçülmez sorulur; `true` ise kare çıkarılmadan
 * `{ probe, frames: [] }` döner. Reddedilecek bir video (90 sn üstü, yatay) için
 * altı kare çözmek — HEVC'de saniyeler sürüyor — boşa beklemek olurdu.
 */
export async function extractFrames(
  file: Blob,
  opts: { count?: number; stopIf?: (probe: VideoProbe) => boolean } = {}
): Promise<FrameExtraction> {
  const count = opts.count ?? FRAME_COUNT;
  await whenVisible(10_000);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  // Özellik atamasını görmeyen eski WebKit sürümleri özniteliği okuyor.
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.preload = "auto";
  video.style.cssText = HIDDEN_VIDEO_STYLE;
  document.body.appendChild(video);
  video.src = url;

  let probe: VideoProbe | null = null;
  const frames: Blob[] = [];
  try {
    await once(video, "loadedmetadata", 15_000);
    probe = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    if (!Number.isFinite(probe.duration) || probe.duration <= 0 || probe.width <= 0) {
      return { probe: null, frames: [], error: "bad-metadata" };
    }
    if (opts.stopIf?.(probe)) return { probe, frames: [] };

    await nudgeDecoder(video);
    // HAVE_CURRENT_DATA (2): en az bir kare çözülmüş. Gelmezse yine de sarmayı
    // deneriz — seek veriyi kendisi de yükleyebilir; rapor için not düşülür.
    let stalled: FrameErrorCode | undefined;
    if (video.readyState < 2) {
      try {
        await once(video, "loadeddata", 10_000);
      } catch (error) {
        if (error instanceof FrameStepError && error.code === "decode") throw error;
        stalled = "loadeddata-timeout";
      }
    }

    const scale = Math.min(1, FRAME_MAX_WIDTH / probe.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(probe.width * scale);
    canvas.height = Math.round(probe.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { probe, frames: [], error: "no-canvas" };

    let error: FrameErrorCode | undefined;
    for (const time of frameTimes(probe.duration, count)) {
      try {
        await seekTo(video, time, 10_000);
      } catch (err) {
        // Kısmi kareler de işe yarar (caption bağlamı); raporda neden kalır.
        error = err instanceof FrameStepError ? err.code : "unknown";
        break;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await toJpeg(canvas);
      if (blob) frames.push(blob);
      else error = "encode";
    }
    // İlk kare hiç çözülmediyse ve sarma da tutmadıysa asıl neden o.
    if (frames.length === 0 && stalled) error = stalled;
    return error ? { probe, frames, error } : { probe, frames };
  } catch (error) {
    return { probe, frames, error: error instanceof FrameStepError ? error.code : "unknown" };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      // jsdom ve bazı eski motorlar `load()`'u uygulamıyor; asıl iş kaynağı bırakmak.
    }
    video.remove();
  }
}

/**
 * `complete` gövdesindeki kare raporu (sunucu tarafı: portal-validation
 * `validateFramesReport`). Karesiz kalan video için operatöre giden uyarının
 * tek bilgi kaynağı: kare mi çıkarılamadı, yoksa yükleme mi düştü?
 */
export type FramesReport = { extracted: number; uploadFailed: number; error?: FrameErrorCode };

/**
 * Kareleri paralel yükler; düşenleri BİR KEZ yeniden dener ve kaç tanesinin
 * gerçekten gittiğini döner. Eskiden hatalar `.catch(() => undefined)` ile
 * yutuluyordu — canlıda karesiz videoların nedeni bu yüzden görünmedi.
 *
 * `freshUrls` verilirse yeniden deneme taze imzalarla yapılır: en olası
 * kalıcı hata süresi dolmuş URL'in 403'ü, aynı URL'le tekrar denemek onu
 * düzeltmez. Taze URL alınamazsa eskileriyle denenir (geçici ağ hatası).
 */
export async function uploadFrameBlobs(
  frames: Blob[],
  urls: string[],
  put: (url: string, body: Blob) => Promise<void>,
  opts: { freshUrls?: () => Promise<string[] | undefined>; wait?: (ms: number) => Promise<void> } = {}
): Promise<{ uploaded: number; failed: number }> {
  const attempt = async (indices: number[], list: string[]) => {
    const results = await Promise.all(
      indices.map(async (n) => {
        if (!list[n]) return false;
        try {
          await put(list[n], frames[n]);
          return true;
        } catch {
          return false;
        }
      })
    );
    return indices.filter((_, i) => !results[i]);
  };

  const all = frames.map((_, n) => n);
  let failed = await attempt(all, urls);
  if (failed.length > 0) {
    const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(1_000);
    const fresh = opts.freshUrls ? await opts.freshUrls().catch(() => undefined) : undefined;
    failed = await attempt(failed, fresh ?? urls);
  }
  return { uploaded: frames.length - failed.length, failed: failed.length };
}

/** README §7 sınırları: ≤ 90 sn ve dikey. Ölçülemeyen video geçer (bkz. `extractFrames`). */
export function probeError(probe: VideoProbe | null): string | null {
  if (!probe) return null;
  if (probe.duration > MAX_DURATION_SEC + 0.5) {
    return `Video ${Math.round(probe.duration)} saniye — en fazla ${MAX_DURATION_SEC} saniye olabilir`;
  }
  if (probe.width > probe.height) {
    return "Video yatay — Reels için dikey video yükle";
  }
  return null;
}

/**
 * İmzalı URL'e doğrudan PUT, ilerleme bildirimiyle. `fetch` yükleme ilerlemesi
 * vermiyor; 300 MB'lık bir videoda ilerleme çubuğu olmadan kullanıcı sayfayı
 * "donmuş" sanıp kapatır. `Content-Type` imzaya dahil (bkz. storage-r2.ts
 * `signPutUrl`): burada farklı bir tip gönderilirse R2 403 döner.
 */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Yükleme reddedildi (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Yükleme sırasında bağlantı koptu"));
    xhr.send(body);
  });
}
