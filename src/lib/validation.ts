export const CAPTION_MAX_LENGTH = 2000;
export const MAX_IMAGES_PER_POST = 10;

/**
 * Makine API'sinin (JSON gövde) görsel URL'i kabul ettiği host'lar. Dar tutulur:
 * URL doğrudan `PostImage.url`'e yazılıp hem müşteriye hem Instagram'a servis
 * edilir — açık bir liste, keyfi host'a görsel proxy'lenmesini engeller.
 */
export const ALLOWED_IMAGE_URL_HOSTS = ["raw.githubusercontent.com"];

/**
 * Vercel Blob'un servis ettiği host soneki — `put()` ve presigned yükleme bu
 * alan adında URL üretir. Store başına ayrı bir alt alan adı olduğu için
 * (`<storeId>.public.blob…`) tam eşleşme değil, sonek kontrolü yapılır.
 *
 * `validation.ts`'te duruyor çünkü hem `blob.ts` (kendi dosyamız mı, silelim mi)
 * hem de aşağıdaki video allowlist'i aynı bilgiye ihtiyaç duyuyor ve bu dosyanın
 * hiç bağımlılığı yok — tersi yönde import, `node:fs`'i validasyonu içeri alan
 * her yere taşırdı.
 */
export const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** Reels videosu için azami boyut. Instagram'ın kendi tavanı 1GB. */
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

/** Presigned yükleme ve `videoUrl` doğrulamasının kabul ettiği video tipleri. */
export const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

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

/**
 * JSON gövdeyle gelen `videoUrl` alanını doğrular. Başarılıysa `null` döner.
 *
 * `validateImageUrls` ile aynı koruma mantığı — URL olduğu gibi `Post.videoUrl`'e
 * yazılıp hem müşteriye hem Instagram'a servis edileceği için host allowlist'i ve
 * https zorunluluğu tek katman. Görselden farkı: Blob host'u da kabul edilir,
 * çünkü video git'e girmiyor (repo'yu şişirirdi) ve presigned yüklemeyle Blob'a
 * çıkıyor. Uzantı kontrolü ek bir kaba eleme; Instagram yine de kendi
 * doğrulamasını container aşamasında yapar.
 */
export function validateVideoUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Video URL'i metin olmalı";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Geçersiz video URL'i: ${value}`;
  }
  if (url.protocol !== "https:") {
    return `Video URL'i https olmalı: ${value}`;
  }
  const hostOk =
    ALLOWED_IMAGE_URL_HOSTS.includes(url.hostname) ||
    url.hostname.endsWith(BLOB_HOST_SUFFIX);
  if (!hostOk) {
    return `Bu host'tan video kabul edilmiyor: ${url.hostname}`;
  }
  if (!/\.(mp4|mov)$/i.test(url.pathname)) {
    return "Video URL'i .mp4 ya da .mov ile bitmeli";
  }
  return null;
}

/**
 * Bir postun medyası: ya görsel(ler) ya bir video — TAM OLARAK biri.
 *
 * Şema bu kısıtı ifade edemiyor (`videoUrl` nullable bir kolon, `images` ayrı
 * bir tablo), o yüzden kapı burası. İkisi birden gelirse hangisinin
 * yayınlanacağı `publish-post.ts`'in dallanma sırasına kalırdı — sessiz ve
 * keyfi bir karar; ikisi de gelmezse post medyasız oluşturulup ancak yayın
 * anında patlardı.
 */
export function validatePostMedia(imageUrls: unknown, videoUrl: unknown): string | null {
  const hasImages = imageUrls !== undefined && imageUrls !== null;
  const hasVideo = videoUrl !== undefined && videoUrl !== null;

  if (hasImages && hasVideo) {
    return "Bir post ya görsel ya video içerir — ikisi birden gönderilemez";
  }
  if (!hasImages && !hasVideo) {
    return "Görsel URL'leri ya da bir video URL'i vermelisin";
  }
  return hasVideo ? validateVideoUrl(videoUrl) : validateImageUrls(imageUrls);
}

/** Presigned yükleme isteğinin beyan ettiği tip ve boyut kabul edilebilir mi. */
export function validateVideoUpload(contentType: unknown, size: unknown): string | null {
  if (typeof contentType !== "string" || !ALLOWED_VIDEO_TYPES[contentType]) {
    return "Yalnızca video/mp4 ya da video/quicktime yüklenebilir";
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return "Dosya boyutu pozitif bir tam sayı olmalı";
  }
  if (size > MAX_VIDEO_BYTES) {
    return `Video en fazla ${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))}MB olabilir`;
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

/** Long-lived Instagram token'ının kabul edilen azami uzunluğu. */
export const IG_ACCESS_TOKEN_MAX_LENGTH = 500;
const IG_ACCESS_TOKEN_MIN_LENGTH = 30;

const IG_USER_ID_RE = /^\d{5,25}$/;

/**
 * Instagram erişim token'ı. Buradaki kontroller yalnızca kaba eleme — token'ın
 * GERÇEKTEN geçerli olup olmadığı Graph'a sorularak (`fetchInstagramAccount`)
 * anlaşılır. Amaç, apaçık yanlış girdiyle (boş, yapıştırma artığı boşluklu metin)
 * Instagram'a istek atmamak.
 */
export function validateInstagramAccessToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Instagram erişim token'ı boş olamaz";
  }
  const token = value.trim();
  if (/\s/.test(token)) {
    return "Instagram erişim token'ı boşluk içeremez";
  }
  if (token.length < IG_ACCESS_TOKEN_MIN_LENGTH) {
    return "Bu bir Instagram erişim token'ına benzemiyor";
  }
  if (token.length > IG_ACCESS_TOKEN_MAX_LENGTH) {
    return `Instagram erişim token'ı en fazla ${IG_ACCESS_TOKEN_MAX_LENGTH} karakter olabilir`;
  }
  return null;
}

/**
 * F8 — zamanlanmış yayın için azami ileri tarih. Instagram long-lived token
 * 60 gün sürüyor (bkz. instagram-token.ts); daha uzağa zamanlama, `publishAt`
 * geldiğinde token'ın süresi dolmuş olma ihtimalini SESSİZCE büyütür — yayın
 * o gün "token süresi doldu" diye `failed` düşer ve kimse neden diye sormaz.
 * Tavan bunu üstünkörü engelliyor; token daha erken yenilenirse sorun olmaz.
 */
export const MAX_PUBLISH_AHEAD_DAYS = 60;

/**
 * `Post.publishAt` (F8). `value` UTC'ye çevrilmiş ISO string olarak beklenir
 * (form yolu Türkiye saatini +03:00 ofsetiyle burada, request'e girmeden ÖNCE
 * çevirir — bkz. post-form.tsx). Boş/`undefined` GEÇERLİDİR: "zamanlama yok,
 * onayda hemen yayınla" anlamına gelir, mevcut davranışın ta kendisi.
 */
export function validatePublishAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "Yayın zamanı geçersiz";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Geçerli bir yayın zamanı gir";
  if (date.getTime() <= Date.now()) return "Yayın zamanı gelecekte olmalı";
  const maxAheadMs = MAX_PUBLISH_AHEAD_DAYS * 24 * 60 * 60 * 1000;
  if (date.getTime() > Date.now() + maxAheadMs) {
    return `Yayın zamanı en fazla ${MAX_PUBLISH_AHEAD_DAYS} gün sonrası olabilir`;
  }
  return null;
}

/**
 * IG professional account id — yalnızca rakam. Arayüzde bu alan boş bırakılabilir;
 * boşsa token'dan türetilir, doluysa token'ın hesabıyla eşleştiği ayrıca kontrol edilir.
 */
export function validateInstagramUserId(value: unknown): string | null {
  if (typeof value !== "string" || !IG_USER_ID_RE.test(value.trim())) {
    return "Instagram hesap kimliği yalnızca rakamlardan oluşmalı";
  }
  return null;
}

/**
 * Token bitiş tarihi ("YYYY-MM-DD" ya da ISO). Boş gönderilirse çağıran taraf
 * `null` yazar — süre bilinmiyorsa yayın akışı token'ı süresiz kabul eder,
 * mevcut davranış budur.
 */
export function validateInstagramTokenExpiry(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "Geçerli bir tarih gir";
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    return "Geçerli bir tarih gir";
  }
  if (date.getTime() <= Date.now()) {
    return "Token bitiş tarihi gelecekte olmalı";
  }
  return null;
}
