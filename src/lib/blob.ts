import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class InvalidImageError extends Error {}

export function validateImage(file: { type: string; size: number }): string | null {
  if (!ALLOWED_IMAGE_TYPES[file.type]) {
    return "Yalnızca JPEG, PNG veya WebP görseller kabul edilir";
  }
  if (file.size === 0) {
    return "Görsel dosyası boş";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Görsel en fazla 10MB olabilir";
  }
  return null;
}

/**
 * İlk baytlardan (magic number) görselin GERÇEK tipini tespit eder.
 *
 * `file.type` istemcinin beyanıdır, doğrulanmaz — sahte bir MIME ile gelen
 * dosya bugüne kadar ancak Instagram'a yayın anında `failed` olarak
 * patlıyordu. Burada tespit edilen tip, `uploadPostImage` içinde beyanla
 * karşılaştırılıp hatayı yükleme anına çekmek için kullanılır.
 */
export function detectImageTypeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

export async function uploadPostImage(file: File): Promise<string> {
  const validationError = validateImage(file);
  if (validationError) throw new InvalidImageError(validationError);

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Beyan edilen MIME ile ilk baytlardan çıkan gerçek tip uyuşmuyorsa reddet.
  // Uzantı de burada tespit edilen gerçek tipten türetilir, beyandan değil —
  // aksi halde sahte MIME'lı dosya yanlış uzantıyla depolanmış olurdu.
  const detectedType = detectImageTypeFromBytes(bytes);
  if (!detectedType || detectedType !== file.type) {
    throw new InvalidImageError(
      "Dosya içeriği beyan edilen görsel tipiyle uyuşmuyor. Dosya bozuk veya yanlış adlandırılmış olabilir."
    );
  }

  const filename = `${randomUUID()}.${ALLOWED_IMAGE_TYPES[detectedType]}`;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // Yerel geliştirme fallback'i: Vercel Blob token'ı yoksa public/uploads'a yazar.
    const dir = path.join(process.cwd(), "public", "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), Buffer.from(bytes));
    return `/uploads/${filename}`;
  }

  const { put } = await import("@vercel/blob");
  const blob = await put(`posts/${filename}`, Buffer.from(bytes), { access: "public" });
  return blob.url;
}

/** Vercel Blob'un servis ettiği host — `put()` bu alan adında URL üretir. */
const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Bir görsel URL'i BİZİM yüklediğimiz blob mu?
 *
 * Ayrım kritik: makine API'siyle (furi) gelen postların görselleri
 * `raw.githubusercontent.com`'da duruyor ve BİZE ait değil. Hepsini körlemesine
 * `del()`'e vermek başkasının kaynağını silmeye çalışmak olurdu — çalışmaz ama
 * niyet olarak da yanlış. Yerel fallback'in `/uploads/...` yolları da Blob'da
 * değil, dosya sisteminde.
 */
export function isOwnBlobUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false; // göreli yol (`/uploads/...`) — URL değil, blob da değil
  }
}

/**
 * Silinen postun görsellerini Blob'dan da kaldırır (F13).
 *
 * "Best-effort" bilinçli: DB satırı zaten silinmiş oluyor ve blob temizliğinin
 * patlaması kullanıcıya "silinemedi" demeyi HAK ETMEZ — post silindi, sadece
 * dosya kaldı. Bu yüzden asla throw etmez, yalnızca loglar.
 */
export async function deletePostImages(urls: string[]): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const ourUrls = urls.filter(isOwnBlobUrl);
  if (ourUrls.length === 0) return;

  try {
    const { del } = await import("@vercel/blob");
    await del(ourUrls);
  } catch (error) {
    console.error("[blob] görsel silinemedi (post yine de silindi):", error);
  }
}
