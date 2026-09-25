/**
 * V7c — sunucu ve istemcinin (push-toggle) ortak sabitleri. Ayrı dosya çünkü
 * `push.ts` `web-push` ve Prisma çekiyor; istemci paketine girmemeli.
 */

/** GET /api/portal/push'ta cihazın endpoint'i bu başlıkla gelir (sorgu dizgisi loglanır). */
export const PUSH_ENDPOINT_HEADER = "x-push-endpoint";
export const PUSH_API_PATH = "/api/portal/push";
