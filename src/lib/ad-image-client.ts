import { AD_CONTENT_TYPE, MAX_AD_BYTES, adRatioOk } from "@/lib/portal-validation";

/**
 * V12b — reklam görselini tarayıcıda yüklemeye hazırlar (K36).
 *
 * Instagram `image_url` yalnızca JPEG, en fazla 8 MB ve 4:5…1.91:1 oranında
 * görsel kabul ediyor; sunucu `complete`te aynı kuralı JPEG başlığından
 * yeniden doğruluyor. Burada iki iş var:
 *   • Oranı tutmayan görseli SEÇİMDE reddetmek — yüklenip sunucudan 400
 *     dönmesini beklemek mobil veride boşa yükleme demek.
 *   • JPEG olmayanı (PNG, HEIC, WebP) ya da 8 MB'ı aşanı canvas üzerinden
 *     JPEG'e yeniden kodlamak. Tasarım çıktısı JPEG dokunulmadan gider:
 *     yeniden kodlamak her seferinde kalite kaybı.
 *
 * Kod çözme `createImageBitmap(..., { imageOrientation: "from-image" })`:
 * telefon fotoğrafının EXIF yönü uygulanmış hâli ölçülür ve yeniden kodlanan
 * dosya yönü piksellere işlenmiş, etiketsiz çıkar (sunucu EXIF okumuyor).
 */

export type DecodedImage = { width: number; height: number; source: CanvasImageSource };

export type ImageDeps = {
  decode: (file: Blob) => Promise<DecodedImage>;
  encode: (image: DecodedImage, width: number, height: number, quality: number) => Promise<Blob>;
};

/** Yeniden kodlamada uzun kenar sınırı: 2160 px tasarım çıktısının boyu, Instagram zaten 1440'a indiriyor. */
export const MAX_ENCODE_EDGE = 2700;
const QUALITIES = [0.9, 0.82, 0.72];

export type PreparedAd =
  | { ok: true; blob: Blob; width: number; height: number; reencoded: boolean }
  | { ok: false; error: string };

export async function prepareAdImage(file: File, deps: ImageDeps = browserImageDeps): Promise<PreparedAd> {
  let image: DecodedImage;
  try {
    image = await deps.decode(file);
  } catch {
    return { ok: false, error: "Görsel açılamadı — JPEG, PNG ya da HEIC seç" };
  }
  if (!adRatioOk(image.width, image.height)) {
    return {
      ok: false,
      error: `Oran Instagram'a uygun değil (${image.width}×${image.height}); dikeyde en fazla 4:5 olabilir`,
    };
  }
  if (file.type === AD_CONTENT_TYPE && file.size > 0 && file.size <= MAX_AD_BYTES) {
    return { ok: true, blob: file, width: image.width, height: image.height, reencoded: false };
  }

  const scale = Math.min(1, MAX_ENCODE_EDGE / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  for (const quality of QUALITIES) {
    try {
      const blob = await deps.encode(image, width, height, quality);
      if (blob.size > 0 && blob.size <= MAX_AD_BYTES) {
        return { ok: true, blob, width, height, reencoded: true };
      }
    } catch {
      return { ok: false, error: "Görsel JPEG'e çevrilemedi" };
    }
  }
  return { ok: false, error: "Görsel 8 MB'a sığdırılamadı" };
}

export const browserImageDeps: ImageDeps = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  encode(image, width, height, quality) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("canvas yok"));
      // Saydam PNG'de JPEG siyah zemin üretir; reklam görseli beyazda okunur.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image.source, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("toBlob boş"))),
        AD_CONTENT_TYPE,
        quality
      );
    });
  },
};
