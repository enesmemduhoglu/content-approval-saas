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

export async function uploadPostImage(file: File): Promise<string> {
  const validationError = validateImage(file);
  if (validationError) throw new InvalidImageError(validationError);

  const filename = `${randomUUID()}.${ALLOWED_IMAGE_TYPES[file.type]}`;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // Yerel geliştirme fallback'i: Vercel Blob token'ı yoksa public/uploads'a yazar.
    const dir = path.join(process.cwd(), "public", "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), Buffer.from(await file.arrayBuffer()));
    return `/uploads/${filename}`;
  }

  const { put } = await import("@vercel/blob");
  const blob = await put(`posts/${filename}`, file, { access: "public" });
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
