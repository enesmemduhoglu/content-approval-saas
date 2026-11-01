import { Client, Receiver } from "@upstash/qstash";
import { bearerToken, secretsMatch } from "@/lib/api-key";

/**
 * Video kuyruğu (V1) — arka plan tetikleyicisi.
 *
 * Vercel Hobby cron'u günde bir ve ±59 dk (CLAUDE.md Tuzaklar); "19:00'da
 * yayınla" buna sığmaz. QStash iki iş yapıyor (K10, K32):
 *   • slot saatinde tek seferlik `POST /api/queue/tick` (`queue-wake.ts`).
 *     Periyodik değil: 5 dakikalık tick Neon compute'unu hiç uyutmadı ve
 *     ücretsiz kotayı ayın 19'unda bitirdi (2026-10, tüm ürün 11 gün kapalı),
 *   • yüklenen her video için bir kez `POST /api/queue/caption/[postId]`
 *     (başarısız isteği kendisi tekrar dener).
 *
 * Kimlik doğrulama `CRON_SECRET` deseniyle aynı sertlikte: imza anahtarları
 * yoksa uç nokta TAMAMEN kapalı. Yedek tetikleyici (cron-job.org) için
 * `Authorization: Bearer CRON_SECRET` de kabul ediliyor.
 */

function receiver(): Receiver | null {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return null;
  return new Receiver({ currentSigningKey, nextSigningKey });
}

/**
 * Kuyruk uç noktalarının kapısı. `rawBody` imzanın parçası — gövde JSON'a
 * çevrilmeden ÖNCE okunmuş ham metin verilmeli (`await request.text()`).
 */
export async function authorizeQueueRequest(
  request: Request,
  rawBody: string
): Promise<boolean> {
  const signature = request.headers.get("upstash-signature");
  if (signature) {
    const r = receiver();
    if (!r) {
      console.error("[qstash] imza anahtarları tanımlı değil — istek reddedildi");
      return false;
    }
    try {
      return await r.verify({ signature, body: rawBody, url: request.url });
    } catch {
      return false;
    }
  }

  const secret = process.env.CRON_SECRET;
  const presented = bearerToken(request);
  if (!secret || !presented) return false;
  return secretsMatch(presented, secret);
}

export function appUrl(): string | null {
  const url = process.env.APP_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

/**
 * Paylaşılan QStash istemcisi; token yoksa `null` (çağıran sessizce atlar).
 *
 * Bölge adresi AÇIKÇA veriliyor: token ve imza anahtarları bölgeye özel
 * (hesap US bölgesinde, DB ve Vercel fonksiyonları da us-east-1). SDK
 * QSTASH_URL'i env'den okuyabiliyor ama bulamazsa sessizce EU adresine
 * düşüyor ve istek orada yetkisiz reddediliyor — hatanın kaynağı da
 * görünmüyor.
 */
export function qstashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return null;
  return new Client({
    token,
    ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
  });
}

export type EnqueueResult = { queued: true; messageId: string } | { queued: false; reason: string };

/**
 * Caption üretimini kuyruğa atar. Asla throw etmez: QStash yoksa ya da
 * patlarsa post `captionStatus = pending` kalır ve portaldaki "yeniden üret"
 * aynı işi elle tetikleyebilir — yükleme bu yüzden başarısız sayılmaz.
 */
export type CaptionJob = {
  postId: string;
  /** Portaldaki "yeniden üret" notu ("daha kısa olsun"); ilk üretimde yok. */
  note?: string;
};

export async function enqueueCaption(
  postId: string,
  opts: { note?: string } = {}
): Promise<EnqueueResult> {
  const client = qstashClient();
  const base = appUrl();
  if (!client || !base) {
    return { queued: false, reason: "QSTASH_TOKEN ya da APP_URL tanımlı değil" };
  }
  try {
    const res = await client.publishJSON({
      url: `${base}/api/queue/caption/${encodeURIComponent(postId)}`,
      body: { postId, ...(opts.note ? { note: opts.note } : {}) } satisfies CaptionJob,
      retries: 3,
    });
    return { queued: true, messageId: res.messageId };
  } catch (error) {
    console.error("[qstash] caption kuyruğa atılamadı", (error as Error).message);
    return { queued: false, reason: "QStash isteği başarısız" };
  }
}
