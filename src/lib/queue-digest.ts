import {
  queueRecipient,
  portalUrl,
  sendQueueDigestEmail,
  type DigestUpcoming,
} from "@/lib/email-queue";
import { isEligible, localParts, projectSchedule } from "@/lib/queue";
import { findQueueClients, loadQueue } from "@/lib/queue-db";
import { MAX_GET_URL_TTL_SECONDS, keyBelongsToClient, signGetUrl } from "@/lib/storage-r2";

/**
 * Video kuyruğu (V4) — günlük müşteri e-postası (README §6, K4).
 *
 * Tek e-postada iki bilgi:
 *  (a) onay AÇIK müşteride "N video onayını bekliyor" — her video için ayrı
 *      mail yerine günde bir özet;
 *  (b) her iki modda "yarın HH:MM'de şu yayınlanacak" + kapak karesi — onay
 *      kapalıyken kullanıcının son görme ve sırayı değiştirme şansı bu.
 * İkisini ayrı ayrı göndermek aynı kutuya aynı saatte iki mail demekti.
 *
 * `pending-reminders` günlük cron'undan çağrılır (Vercel Hobby: günde bir,
 * ±59 dk). "Yarın" müşterinin YEREL takvimine göre hesaplanır.
 *
 * ─── Tekrar gönderim (idempotency) — sınırı açıkça ──────────────────────────
 * Şema değiştirilmeden çözüldü, yani "bu özet gitti" damgası DB'de YOK.
 * Koruma iki katmanlı ve ikisi de tam değil:
 *  1. Cron günde bir koşuyor ve Vercel başarısız cron'u kendiliğinden tekrar
 *     denemiyor — normal işleyişte müşteri başına günde tek e-posta.
 *  2. Aynı sıcak instance'ta aynı gün ikinci kez tetiklenirse (elle tetikleme,
 *     art arda deploy) `sentKeys` o müşteri + yerel gün için ikinci gönderimi
 *     keser.
 * Açık kalan: soğuk başlangıçta ya da başka instance'ta aynı gün elle
 * tetiklenirse özet ikinci kez gider. Bedeli bir fazla bilgi maili; kalıcı
 * çözüm `PublishSettings`e bir `digestSentOn` kolonu (şema değişikliği).
 */

/** Takvimi hesaplarken bakılacak azami video sayısı; yarının slotlarına fazlasıyla yeter. */
const PROJECTION_LIMIT = 30;

const sentKeys = new Set<string>();

/** Testlerin süreç içi korumayı sıfırlayabilmesi için. */
export function resetQueueDigestForTests(): void {
  sentKeys.clear();
}

function dayKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Kapak karesi: ilk kare, 7 günlük imzalı URL. Üretilemezse görselsiz gider. */
async function coverUrl(clientId: string, frameKeys: string[]): Promise<string | null> {
  const key = frameKeys[0];
  // İmzalı URL yalnızca anahtar bu müşterinin önekindeyse (storage-r2 kuralı).
  if (!key || !keyBelongsToClient(key, clientId)) return null;
  try {
    return await signGetUrl(key, MAX_GET_URL_TTL_SECONDS);
  } catch (error) {
    // R2 yapılandırılmamış olabilir: özet yine gitsin, yalnızca görselsiz.
    console.warn(`[queue:digest] kapak imzalanamadı (${clientId}):`, (error as Error).message);
    return null;
  }
}

export type QueueDigestStats = {
  checked: number;
  sent: number;
  failed: number;
  /** Aynı gün zaten gönderilmiş (süreç içi koruma). */
  duplicate: number;
};

export async function runQueueDigest(now: Date = new Date()): Promise<QueueDigestStats> {
  const stats: QueueDigestStats = { checked: 0, sent: 0, failed: 0, duplicate: 0 };
  const clients = await findQueueClients();

  for (const settings of clients) {
    // Duraklatılmış kuyruk yayın yapmayacak; "yarın şu yayınlanacak" yalan olur.
    if (settings.paused) continue;
    stats.checked += 1;

    // Müşteri başına yutulur: birinin hatası diğerlerinin özetini durdurmasın.
    try {
      const { client } = settings;
      const today = localParts(now, settings.timezone);
      // Takvim aritmetiği UTC'de: yerel "bugün"ün bir sonraki takvim günü.
      const tomorrowKey = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
        .toISOString()
        .slice(0, 10);
      const guardKey = `${client.id}:${tomorrowKey}`;
      if (sentKeys.has(guardKey)) {
        stats.duplicate += 1;
        continue;
      }

      const queue = await loadQueue(client.id);
      const pendingCount = settings.requireApproval
        ? queue.filter((post) => post.status === "pending" && isEligible(post, false)).length
        : null;

      const byId = new Map(queue.map((post) => [post.id, post]));
      const projected = projectSchedule(queue, settings, now, PROJECTION_LIMIT).filter(
        (slot) => dayKey(localParts(slot.slotAt, settings.timezone)) === tomorrowKey
      );
      const upcoming: DigestUpcoming[] = [];
      for (const slot of projected) {
        const post = byId.get(slot.postId)!;
        upcoming.push({
          slotAt: slot.slotAt,
          caption: post.caption,
          coverUrl: await coverUrl(client.id, post.frameKeys),
        });
      }

      // Anlatacak bir şey yoksa mail yok — "yarın hiçbir şey yok" her gün gelirse
      // okunmaz olur. (Onay bekleyen yoksa ve yarın slot boşsa, slotun kendisi
      // geldiğinde "boş kaldı" e-postası zaten gidiyor.)
      if (upcoming.length === 0 && !(pendingCount && pendingCount > 0)) continue;

      const result = await sendQueueDigestEmail({
        to: queueRecipient(settings, client.email),
        clientName: client.name,
        timezone: settings.timezone,
        pendingCount,
        upcoming,
        portalUrl: portalUrl(),
      });
      if (result.sent) {
        sentKeys.add(guardKey);
        stats.sent += 1;
      } else {
        // Damga yok: aynı gün tekrar tetiklenirse yeniden denenebilir.
        stats.failed += 1;
        console.error(`[queue:digest] ${client.id} özeti gitmedi: ${result.reason}`);
      }
    } catch (error) {
      stats.failed += 1;
      console.error(`[queue:digest] ${settings.clientId} işlenemedi:`, error);
    }
  }

  return stats;
}
