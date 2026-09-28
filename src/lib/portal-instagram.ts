import {
  daysUntilExpiry,
  isInstagramTokenExpired,
  isPublishTarget,
  type PublishTargetClient,
} from "@/lib/instagram-token";

/**
 * Portal — Instagram bağlantısının müşteriye söylenen hâli (2026-09-28 analizi).
 *
 * Bağlantı yoksa ya da token'ın süresi dolmuşsa tick videoyu HARCAMADAN slotu
 * boş geçiyor (bkz. `queue/tick` `runSlot`), ama portal "Sıradaki yayın
 * 19:00" demeye devam ediyordu: müşteri yayının neden çıkmadığını bilmiyordu.
 * Kontrol tick'le aynı iki fonksiyondan geçer — iki ayrı kural olmasın.
 *
 * Bağlantıyı yalnızca ajans onarabilir; portal bunu söyler, düğme sunmaz.
 */

/**
 * Kaç gün kala müşteri uyarılır. Ajans panelindeki şeritten (10 gün) BİLEREK
 * dar: cron 20 gün kala yenilemeye başlıyor, ajans 10 gün kala uyarı görüyor;
 * müşteriye ancak ajans da 5 gün boyunca bir şey yapmadıysa söylenir.
 */
export const PORTAL_IG_WARNING_DAYS = 5;

export type InstagramHealth =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "expired" }
  | { state: "expiring"; expiresAt: Date; daysLeft: number };

export function instagramHealth(
  client: PublishTargetClient & { instagramTokenExpiry: Date | null },
  now: Date = new Date()
): InstagramHealth {
  if (!isPublishTarget(client)) return { state: "missing" };
  const expiry = client.instagramTokenExpiry;
  // Bitiş tarihi bilinmeyen token'a tick de dokunmuyor: "ok".
  if (!expiry) return { state: "ok" };
  if (isInstagramTokenExpired(expiry, now)) return { state: "expired" };
  const daysLeft = daysUntilExpiry(expiry, now);
  if (daysLeft <= PORTAL_IG_WARNING_DAYS) return { state: "expiring", expiresAt: expiry, daysLeft };
  return { state: "ok" };
}

/** Yayın akışı durdu mu — kuyruk ekranı "Sıradaki yayın" yerine bunu söyler. */
export function isInstagramBlocked(health: InstagramHealth): boolean {
  return health.state === "missing" || health.state === "expired";
}
