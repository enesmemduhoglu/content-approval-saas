/**
 * Portal ekranlarının tarih/metin biçimleri (mobil arayüz, V7). Saf
 * fonksiyonlar: sunucu bileşenleri çağırıyor, testler sabit `now` ile.
 *
 * Her hesap MÜŞTERİNİN saat diliminde. Sunucu (Vercel) UTC'de koşuyor;
 * "bugün/yarın" UTC'ye göre hesaplansaydı İstanbul'da gece 00–03 arası
 * yarınki yayın "Bugün" görünürdü.
 */

/** Takvim günü, verilen saat diliminde: "2026-09-25". */
function dayKey(at: Date, timezone: string): string {
  // en-CA biçimi YYYY-MM-DD; parçalamadan karşılaştırılabilir.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** İki takvim günü arasındaki fark (gün); saat dilimi geçişlerinden etkilenmez. */
function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function formatTime(at: Date, timezone: string): string {
  return at.toLocaleTimeString("tr-TR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
}

/**
 * Yayın zamanının gün kısmı: "Bugün", "Yarın" ya da "Paz 27 Eyl". Tasarımdaki
 * "Yarın · 19:00" kalıbı; ikiye ayrı dönüyor çünkü büyük kartta ve küçük
 * satırda farklı birleştiriliyor.
 */
export function slotDayLabel(at: Date, timezone: string, now: Date = new Date()): string {
  const diff = dayDiff(dayKey(now, timezone), dayKey(at, timezone));
  if (diff === 0) return "Bugün";
  if (diff === 1) return "Yarın";
  const weekday = at.toLocaleDateString("tr-TR", { timeZone: timezone, weekday: "short" });
  const date = at.toLocaleDateString("tr-TR", { timeZone: timezone, day: "numeric", month: "short" });
  return `${weekday} ${date}`;
}

/** "Yarın · 19:00" */
export function slotLabel(at: Date, timezone: string, now: Date = new Date()): string {
  return `${slotDayLabel(at, timezone, now)} · ${formatTime(at, timezone)}`;
}

/** Geçmiş kartındaki tarih: "25 Eyl · 19:00" — geçmişte "Bugün" demek yerine hep takvim tarihi. */
export function shortDateTime(at: Date, timezone: string): string {
  const date = at.toLocaleDateString("tr-TR", { timeZone: timezone, day: "numeric", month: "short" });
  return `${date} · ${formatTime(at, timezone)}`;
}

/**
 * Geçmiş listesinin ara başlığı: "BU HAFTA", "GEÇEN HAFTA" ya da "EYLÜL 2026".
 * Hafta Pazartesi başlar (Türkiye takvimi).
 */
export function historyGroup(at: Date, timezone: string, now: Date = new Date()): string {
  const today = dayKey(now, timezone);
  // 0 = Pazartesi … 6 = Pazar (UTC gece yarısı üzerinden: dilim zaten dayKey'de uygulandı).
  const weekdayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const ago = dayDiff(dayKey(at, timezone), today);
  if (ago <= weekdayIndex) return "BU HAFTA";
  if (ago <= weekdayIndex + 7) return "GEÇEN HAFTA";
  return at
    .toLocaleDateString("tr-TR", { timeZone: timezone, month: "long", year: "numeric" })
    .toLocaleUpperCase("tr-TR");
}

/**
 * "furkan@gmail.com" → "f••••@gmail.com". Kod ekranında kodun NEREYE gittiğini
 * hatırlatmak için; tam adres omuz üstünden okunmasın.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return trimmed;
  return `${Array.from(trimmed)[0]}••••${trimmed.slice(at)}`;
}

/** Ayarlar'daki "Günde 2 video · Türkiye saati" satırının dilim kısmı. */
export function timezoneLabel(timezone: string): string {
  return timezone === "Europe/Istanbul" ? "Türkiye saati" : timezone.replace(/_/g, " ");
}
