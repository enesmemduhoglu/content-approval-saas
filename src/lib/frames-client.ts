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

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} zaman aşımı`));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Video okunamadı"));
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
 * Videonun süresini/boyutunu ölçer ve kareleri çıkarır.
 *
 * Kare çıkarma başarısız olursa (tarayıcı codec'i açamıyor — ör. masaüstü
 * Chrome'da bazı HEVC .mov dosyaları) HATA FIRLATMAZ: `probe: null, frames: []`
 * döner. Video yine yüklenir; caption yalnızca transkriptle üretilir. Kare
 * yüzünden yüklemeyi engellemek, kullanıcının asıl işini (videoyu kuyruğa
 * koymak) ikincil bir özelliğe rehin etmek olurdu.
 */
export async function extractFrames(
  file: Blob,
  count: number = FRAME_COUNT
): Promise<{ probe: VideoProbe | null; frames: Blob[] }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await once(video, "loadedmetadata", 15_000);
    const probe = {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
    if (!Number.isFinite(probe.duration) || probe.duration <= 0 || probe.width <= 0) {
      return { probe: null, frames: [] };
    }

    const scale = Math.min(1, FRAME_MAX_WIDTH / probe.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(probe.width * scale);
    canvas.height = Math.round(probe.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { probe, frames: [] };

    const frames: Blob[] = [];
    for (let i = 0; i < count; i++) {
      // Aralıkların ORTASI: 0. saniye çoğu videoda siyah/geçiş karesi.
      video.currentTime = (probe.duration * (i + 0.5)) / count;
      try {
        await once(video, "seeked", 10_000);
      } catch {
        break;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await toJpeg(canvas);
      if (blob) frames.push(blob);
    }
    return { probe, frames };
  } catch {
    return { probe: null, frames: [] };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
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
