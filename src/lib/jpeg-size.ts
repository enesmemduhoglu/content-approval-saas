/**
 * V12 — JPEG'in piksel boyutu, başlıktaki SOF segmentinden. Saf, bağımlılıksız.
 *
 * Neden sunucuda okunuyor: reklam görseli tarayıcıdan doğrudan R2'ye gidiyor ve
 * istemcinin "4:5'tir" beyanına güvenilmez (`complete` route'unun HEAD
 * kontrolüyle aynı gerekçe). Oranı Instagram'ın sınırının dışındaki görsel
 * kuyrukta haftalarca bekleyip yayın anında `failed` olurdu; yüklerken
 * reddetmek kullanıcıya hatayı o an, düzeltebileceği yerde gösteriyor.
 * `sharp` yerine elle: tek ihtiyaç iki sayı, `sharp` istek yoluna hiç girmiyor
 * (CLAUDE.md audit notu) ve öyle kalsın.
 *
 * EXIF yönü OKUNMAZ: telefonla çekilmiş, "döndür" etiketli bir fotoğrafta
 * kayıtlı boyut görünenin tersi olabilir. Portal seçici JPEG olmayan ya da
 * büyük dosyayı canvas'tan yeniden kodluyor (yön uygulanmış, etiketsiz);
 * reklam görselleri de tasarım çıktısı, kamera fotoğrafı değil.
 */

/** Boyut taşıyan "Start Of Frame" işaretleri (C4 DHT, C8 JPG, CC DAC hariç). */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // segment sınırı bozuk
    // Segmentler arası dolgu baytları (0xFF tekrarı) serbest.
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1;
      marker = bytes[i + 1];
    }
    i += 2;
    // Uzunluk taşımayan tek baytlık işaretler.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // görüntü verisi başladı, SOF yoktu
    if (i + 1 >= bytes.length) return null;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (i + 6 >= bytes.length) return null;
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += length;
  }
  return null;
}
