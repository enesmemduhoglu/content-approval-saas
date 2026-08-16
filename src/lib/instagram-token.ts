/**
 * Instagram erişim token'ının ömrüyle ilgili tek doğruluk kaynağı.
 *
 * Token 60 günlük (long-lived) ve süresi dolduğunda yayın SESSİZCE durur:
 * `publishApprovedPost` hızlı hata verir, post `failed` olur. Ajans bunu ancak
 * bir post patlayınca fark etmesin diye dashboard'da proaktif uyarı gösterilir.
 *
 * Yenileme (bu modülün kapsamı dışında, elle yapılıyor):
 *   GET https://graph.instagram.com/refresh_access_token
 *       ?grant_type=ig_refresh_token&access_token=<mevcut token>
 * Not: otomatik yenileme (cron) henüz yok — TODOS.md'ye bakınız.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Kaç gün kala uyarı şeridi çıkar. Eşik SADECE burada tanımlıdır. */
export const IG_TOKEN_WARNING_DAYS = 10;

/** Uyarı hesabı için gereken müşteri alanları — token'ın KENDİSİ hiç geçmez. */
export type TokenAlertClient = {
  id: string;
  name: string;
  /** Instagram bağlı değilse token uyarısı anlamsızdır; uyarı çıkmaz. */
  instagramConnected: boolean;
  instagramTokenExpiry: Date | null;
};

export type InstagramTokenAlert = {
  clientId: string;
  clientName: string;
  /**
   * Kalan tam gün (yukarı yuvarlanmış). Süresi dolmuşsa 0 ya da negatif olur;
   * mutlak değeri "kaç gün önce doldu" demektir.
   */
  daysLeft: number;
  expired: boolean;
};

/**
 * Token süresi dolmuş mu? `publishApprovedPost` da bunu kullanır — yayın
 * tarafındaki hızlı hata ile paneldeki uyarı aynı eşiği paylaşsın diye.
 */
export function isInstagramTokenExpired(
  expiry: Date | null | undefined,
  now: Date = new Date()
): boolean {
  return !!expiry && expiry.getTime() <= now.getTime();
}

/** Kalan gün sayısı; yarım günler ajansın lehine yukarı yuvarlanır. */
export function daysUntilExpiry(expiry: Date, now: Date = new Date()): number {
  return Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Uyarı gerektiren müşteriler — en acili (süresi dolmuş olan) başta olacak
 * şekilde sıralı. Instagram bağlı olmayan ya da son kullanma tarihi bilinmeyen
 * müşteriler listeye hiç girmez.
 */
export function instagramTokenAlerts(
  clients: TokenAlertClient[],
  now: Date = new Date()
): InstagramTokenAlert[] {
  return clients
    .filter((client) => client.instagramConnected && client.instagramTokenExpiry !== null)
    .map((client) => {
      const expiry = client.instagramTokenExpiry as Date;
      return {
        clientId: client.id,
        clientName: client.name,
        daysLeft: daysUntilExpiry(expiry, now),
        expired: isInstagramTokenExpired(expiry, now),
      };
    })
    .filter((alert) => alert.expired || alert.daysLeft <= IG_TOKEN_WARNING_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
