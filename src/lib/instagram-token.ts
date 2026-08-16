/**
 * Instagram erişim token'ının ömrüyle ilgili tek doğruluk kaynağı.
 *
 * Token 60 günlük (long-lived) ve süresi dolduğunda yayın SESSİZCE durur:
 * `publishApprovedPost` hızlı hata verir, post `failed` olur. Ajans bunu ancak
 * bir post patlayınca fark etmesin diye dashboard'da proaktif uyarı gösterilir.
 *
 * Yenileme:
 *   GET https://graph.instagram.com/refresh_access_token
 *       ?grant_type=ig_refresh_token&access_token=<mevcut token>
 * Günlük cron (`/api/cron/refresh-instagram-tokens`) bunu otomatik yapar;
 * çağrının kendisi `instagram.ts`'teki `refreshInstagramToken` içindedir.
 * Uyarı şeridi ikinci savunma hattı olarak durur — cron da patlayabilir.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Kaç gün kala uyarı şeridi çıkar. Eşik SADECE burada tanımlıdır. */
export const IG_TOKEN_WARNING_DAYS = 10;

/**
 * Kaç gün kala cron token'ı yeniler. Uyarı eşiğinden BİLEREK geniş: cron
 * ajans hiçbir uyarı görmeden işini bitirsin, uyarı şeridi ancak otomatik
 * yenileme çalışmadığında (cron kapalı, token reddedildi) görünsün.
 *
 * 20 gün nereden: token 60 günlük, cron günde bir kez koşuyor. Pencere 20 gün
 * boyunca açık kaldığından üst üste ~20 deneme hakkı var — tek bir Instagram
 * kesintisi ya da atlanan cron koşusu token'ı kaybettirmez. Daha erken
 * yenilemenin faydası yok: yenileme süreyi UZATMAZ, sadece "şu andan itibaren
 * 60 gün"e sıfırlar; 60. güne yakın yenilemek toplam ömrü en verimli kullanır.
 */
export const IG_TOKEN_REFRESH_DAYS = 20;

export type PublishTargetClient = {
  instagramUserId: string | null;
  instagramAccessToken: string | null;
};

/**
 * "Bu müşterinin postu onaylanınca Instagram'a düşer mi?" sorusunun TEK yeri.
 * Toplu onay bu postları dışarıda bırakır (yayın tek tek onay yolunda yapılır),
 * panel de onaylanıp yayınlanmamış postları buna bakarak işaretler.
 *
 * `publish-post.ts` yerine burada duruyor: yüklem saf, yalnızca müşteri
 * alanlarına bakıyor ve `scoped-db.ts` de buna ihtiyaç duyuyor — yayın
 * modülünü (ve dolayısıyla Instagram HTTP katmanını) veri katmanına
 * sürüklememek için ortak leaf modül burası.
 */
export function isPublishTarget<T extends PublishTargetClient>(
  client: T
): client is T & { instagramUserId: string; instagramAccessToken: string } {
  return Boolean(client.instagramUserId && client.instagramAccessToken);
}

/**
 * Cron'un bir müşteri için verdiği karar:
 *  - `refresh` : yenileme penceresinde, token geçerli → Instagram'a gidilir
 *  - `expired` : süresi ZATEN dolmuş → yenilenemez, ajansın hesabı elle yeniden
 *                bağlaması gerekir (Instagram dolmuş token'ı uzatmaz)
 *  - `skip`    : yapılacak bir şey yok (bağlı değil, tarih bilinmiyor ya da
 *                pencereye daha var)
 */
export type TokenRefreshDecision = "refresh" | "expired" | "skip";

/** Yenileme kararı için gereken müşteri alanları. */
export type TokenRefreshClient = {
  instagramUserId: string | null;
  instagramAccessToken: string | null;
  instagramTokenExpiry: Date | null;
};

/**
 * "Bu müşterinin token'ı yenilenmeli mi?" sorusunun TEK yeri — saf yüklem,
 * ne DB'ye ne ağa dokunur; cron yalnızca bunun kararını uygular.
 *
 * `instagramTokenExpiry` null ise `skip`: bitiş tarihi bilinmeyen bir token
 * için "pencerede mi" sorusu yanıtsızdır ve uyarı şeridi de (bkz.
 * `instagramTokenAlerts`) aynı müşteriyi atlar — iki taraf tutarlı kalsın diye.
 */
export function instagramTokenRefreshDecision(
  client: TokenRefreshClient,
  now: Date = new Date()
): TokenRefreshDecision {
  if (!isPublishTarget(client)) return "skip";
  if (client.instagramTokenExpiry === null) return "skip";
  if (isInstagramTokenExpired(client.instagramTokenExpiry, now)) return "expired";
  return daysUntilExpiry(client.instagramTokenExpiry, now) <= IG_TOKEN_REFRESH_DAYS
    ? "refresh"
    : "skip";
}

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
