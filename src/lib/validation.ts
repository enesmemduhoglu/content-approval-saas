export const CAPTION_MAX_LENGTH = 2000;
export const MAX_IMAGES_PER_POST = 10;

/**
 * Makine API'sinin (JSON gövde) görsel URL'i kabul ettiği host'lar. Dar tutulur:
 * URL doğrudan `PostImage.url`'e yazılıp hem müşteriye hem Instagram'a servis
 * edilir — açık bir liste, keyfi host'a görsel proxy'lenmesini engeller.
 */
export const ALLOWED_IMAGE_URL_HOSTS = ["raw.githubusercontent.com"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCaption(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Caption boş olamaz";
  }
  if (value.length > CAPTION_MAX_LENGTH) {
    return `Caption en fazla ${CAPTION_MAX_LENGTH} karakter olabilir`;
  }
  return null;
}

/**
 * JSON gövdeyle gelen `imageUrls` alanını doğrular. Başarılıysa `null` döner.
 * Blob'a yükleme yapılmaz — URL'ler olduğu gibi kaydedileceği için host
 * allowlist'i ve https zorunluluğu tek koruma katmanıdır.
 */
export function validateImageUrls(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return "En az bir görsel URL'i vermelisin";
  }
  if (value.length > MAX_IMAGES_PER_POST) {
    return `En fazla ${MAX_IMAGES_PER_POST} görsel gönderebilirsin`;
  }
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return "Görsel URL'leri metin olmalı";
    }
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return `Geçersiz görsel URL'i: ${item}`;
    }
    if (url.protocol !== "https:") {
      return `Görsel URL'i https olmalı: ${item}`;
    }
    if (!ALLOWED_IMAGE_URL_HOSTS.includes(url.hostname)) {
      return `Bu host'tan görsel kabul edilmiyor: ${url.hostname}`;
    }
  }
  return null;
}

export function validateClientName(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Müşteri adı boş olamaz";
  }
  if (value.length > 200) {
    return "Müşteri adı en fazla 200 karakter olabilir";
  }
  return null;
}

export function validateClientEmail(value: unknown): string | null {
  if (typeof value !== "string" || !EMAIL_RE.test(value.trim())) {
    return "Geçerli bir e-posta adresi gir";
  }
  return null;
}
