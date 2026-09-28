/**
 * Video kuyruğu (V9) — R2 saklama süreleri, saf kurallar. Temizlik işi
 * (`media-retention.ts`) ve portalın "X gün sonra silinecek" metinleri aynı
 * sabitleri buradan okur: ekranda yazan süre ile silinme anı ayrışamasın.
 *
 * R2'nin ücretsiz katmanı 10 GB; video ~50 MB, günde bir video temizliksiz
 * birkaç ayda doldurur. Kararlar (K30): yayınlanan videonun kendisi 2 gün
 * sonra silinir (Instagram'da kopyası var), ilk kare kapak olarak kalır;
 * kuyruk dışı (reddedilen ya da çıkarılan) video 3 gün sonra tamamen gider.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Yayından bu kadar sonra mp4 ve kapak dışındaki kareler silinir. */
export const PUBLISHED_VIDEO_TTL_MS = 2 * DAY_MS;
/** Kuyruk dışına çıktıktan bu kadar sonra video (satırı ve dosyaları) silinir. */
export const OUTSIDE_TTL_MS = 3 * DAY_MS;

/** Kuyruk dışı videonun silineceği an; kuyruk dışında değilse `null`. */
export function outsideDeletesAt(outsideAt: Date | null): Date | null {
  return outsideAt ? new Date(outsideAt.getTime() + OUTSIDE_TTL_MS) : null;
}

/**
 * Yayınlanan videonun dosyasının kaldırılacağı an. `publishedAt` boşsa (ör.
 * `duplicate`) son değişiklik: temizlik sorgusu da aynı yedeği kullanıyor.
 */
export function videoArchivesAt(publishedAt: Date | null, updatedAt: Date): Date {
  return new Date((publishedAt ?? updatedAt).getTime() + PUBLISHED_VIDEO_TTL_MS);
}

/** Takvim günü, verilen saat diliminde: "2026-09-25" (en-CA biçimi YYYY-MM-DD). */
function dayKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * `now`'dan `at`e kaç TAKVİM günü var (müşterinin saat diliminde); geçmişse 0.
 * 24 saatlik dilimler yerine takvim günü: Pazartesi 23:00'te reddedilen
 * videonun Perşembe 23:00'teki silinmesi Salı sabahı "2 gün sonra" okunmalı,
 * "3 gün sonra" değil — kullanıcı günleri sayıyor, saatleri değil.
 */
export function calendarDaysUntil(at: Date, now: Date, timezone: string): number {
  const diff = Math.round(
    (Date.parse(`${dayKey(at, timezone)}T00:00:00Z`) - Date.parse(`${dayKey(now, timezone)}T00:00:00Z`)) /
      DAY_MS
  );
  return Math.max(0, diff);
}

/** Kuyruk dışı kartın sayacı: "3 gün sonra silinecek" / "Yarın silinecek" / "Bugün silinecek". */
export function deletionLabel(days: number): string {
  if (days <= 0) return "Bugün silinecek";
  if (days === 1) return "Yarın silinecek";
  return `${days} gün sonra silinecek`;
}

/** Geçmiş kartının notu: videosu hâlâ duran yayında "Video 2 gün daha burada". */
export function videoStaysLabel(days: number): string {
  if (days <= 0) return "Video bugün kaldırılacak";
  return `Video ${days} gün daha burada`;
}
