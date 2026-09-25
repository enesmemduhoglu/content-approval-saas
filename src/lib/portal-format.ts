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

/**
 * "Sıradaki yayın" kartının gün kısmı (V8): "Bugün", "Yarın", bir hafta
 * içindeyse tam gün adı ("Perşembe"), daha uzaksa gün adı + tarih
 * ("Pazartesi 12 Eki"). Yayın günleri seçilince sıradaki yayın birkaç gün
 * uzakta olabiliyor; "Per 1 Eki" yerine gün adı ritmi tek bakışta söylüyor.
 * Tarih yalnızca gün adının belirsiz kaldığı yerde (7+ gün) eklenir.
 */
export function slotWeekdayLabel(at: Date, timezone: string, now: Date = new Date()): string {
  const diff = dayDiff(dayKey(now, timezone), dayKey(at, timezone));
  if (diff === 0) return "Bugün";
  if (diff === 1) return "Yarın";
  const weekday = at.toLocaleDateString("tr-TR", { timeZone: timezone, weekday: "long" });
  if (diff > 1 && diff < 7) return weekday;
  const date = at.toLocaleDateString("tr-TR", { timeZone: timezone, day: "numeric", month: "short" });
  return `${weekday} ${date}`;
}

/** Ayarlar özetindeki satır: "Perşembe · 2 Eki · 19:00" — her zaman takvim tarihiyle. */
export function weekdayDateTime(at: Date, timezone: string): string {
  const weekday = at.toLocaleDateString("tr-TR", { timeZone: timezone, weekday: "long" });
  const date = at.toLocaleDateString("tr-TR", { timeZone: timezone, day: "numeric", month: "short" });
  return `${weekday} · ${date} · ${formatTime(at, timezone)}`;
}

// ─── Yayın günleri (V8) ────────────────────────────────────────────────────

/** ISO sırasıyla (1 = Pazartesi … 7 = Pazar) gün adları. */
export const WEEKDAYS: readonly { iso: number; short: string; long: string }[] = [
  { iso: 1, short: "Pzt", long: "Pazartesi" },
  { iso: 2, short: "Sal", long: "Salı" },
  { iso: 3, short: "Çar", long: "Çarşamba" },
  { iso: 4, short: "Per", long: "Perşembe" },
  { iso: 5, short: "Cum", long: "Cuma" },
  { iso: 6, short: "Cmt", long: "Cumartesi" },
  { iso: 7, short: "Paz", long: "Pazar" },
];

/** Hazır seçimler — sıra ekrandaki sıra. */
export const DAY_PRESETS: readonly { label: string; days: readonly number[] }[] = [
  { label: "Her gün", days: [1, 2, 3, 4, 5, 6, 7] },
  { label: "Hafta içi", days: [1, 2, 3, 4, 5] },
  { label: "Hafta sonu", days: [6, 7] },
];

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((d, i) => d === b[i]);

/** Sıralı gün listesi bir hazır seçime denk geliyorsa onun adı. */
export function presetFor(days: readonly number[]): string | null {
  return DAY_PRESETS.find((p) => sameDays(p.days, days))?.label ?? null;
}

/** "Her gün" · "Haftada 3 gün" — gün başlığının sağındaki sayaç. */
export function dayCountLabel(days: readonly number[]): string {
  return days.length === 7 ? "Her gün" : `Haftada ${days.length} gün`;
}

/**
 * Özet kutusunun başlığı: "Haftada 3 video · Pzt, Per, Cum · 19:00".
 * Her gün seçiliyse "Her gün 2 video · 09:30, 19:00" (gün listesini ikinci
 * kez "Her gün" diye tekrarlamaz). `days` sıralı, `slots` geçerli ve sıralı
 * saatler olmalı.
 */
export function scheduleSummary(days: readonly number[], slots: readonly string[]): string {
  const times = slots.join(", ");
  if (days.length === 7) return `Her gün ${slots.length} video · ${times}`;
  const dayList = presetFor(days) ?? days.map((d) => WEEKDAYS[d - 1].short).join(", ");
  return `Haftada ${days.length * slots.length} video · ${dayList} · ${times}`;
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
