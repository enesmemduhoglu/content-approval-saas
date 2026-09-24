import { Client, Receiver } from "@upstash/qstash";
import { bearerToken, secretsMatch } from "@/lib/api-key";

/**
 * Video kuyruğu (V1) — arka plan tetikleyicisi.
 *
 * Vercel Hobby cron'u günde bir ve ±59 dk (CLAUDE.md Tuzaklar); "19:00'da
 * yayınla" buna sığmaz. QStash iki iş yapıyor (K7, K10):
 *   • her 5 dakikada `POST /api/queue/tick`,
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

function appUrl(): string | null {
  const url = process.env.APP_URL;
  return url ? url.replace(/\/+$/, "") : null;
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
  const token = process.env.QSTASH_TOKEN;
  const base = appUrl();
  if (!token || !base) {
    return { queued: false, reason: "QSTASH_TOKEN ya da APP_URL tanımlı değil" };
  }
  try {
    const client = new Client({ token });
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
