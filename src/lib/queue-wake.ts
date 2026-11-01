import { sendAlert } from "@/lib/alerts";
import { appUrl, qstashClient } from "@/lib/qstash";
import { slotInstants, type QueueSettings } from "@/lib/queue";
import {
  claimWake,
  deleteWake,
  findQueueSchedules,
  listWakesFrom,
  pruneWakesBefore,
  setWakeMessageId,
} from "@/lib/queue-db";

/**
 * Video kuyruğu (V11, K32) — tick'i slot saatinde uyandırmak.
 *
 * Eskiden QStash `*\/5` ile tick'i her 5 dakikada çağırıyordu. Neon ücretsiz
 * planında compute 5 dk boşta kalınca uyuyor; 5 dakikada bir gelen istek onu
 * hiç uyutmadı (ayda ~186 CU-saat, kota 100) ve kota 2026-10-19'da bitince
 * TÜM ürün 11 gün kapalı kaldı. Şimdi tick yalnızca bir slotun saati
 * geldiğinde çağrılıyor:
 *
 *   • `syncQueueWakes` önümüzdeki `WAKE_HORIZON_MS` içindeki her slot anı için
 *     tek seferlik bir QStash mesajı (`notBefore`) kurar. Ayar kaydında,
 *     günlük cron'da ve `POST /api/queue/arm` ile çağrılır.
 *   • Tick bitmemiş iş bırakırsa (bütçe doldu, Instagram videoyu hâlâ
 *     işliyor) `scheduleFollowUp` kısa bir takip mesajı kurar.
 *
 * Neden periyodik bir "emniyet tick'i" yok: saatte bir bile olsa her uyanma
 * compute'u ~5 dk açık tutuyor. Yerine ufuk geniş tutuldu — bir senkron
 * kaçsa da önümüzdeki günlerin mesajları zaten QStash'te.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kaç gün ilerisi kurulur. QStash ücretsiz planın gecikme tavanı 7 gün; 6 gün
 * hem tavanın altında pay bırakıyor hem de günlük senkron birkaç gün koşmasa
 * bile hiçbir slotu açıkta bırakmıyor.
 */
export const WAKE_HORIZON_MS = 6 * DAY_MS;

/** Bütçe dolduğu için sahiplenilmeden bırakılan slot — pencere (1 saat) içinde hemen tekrar. */
export const FOLLOW_UP_DEFERRED_SEC = 60;
/** Instagram'ın işlediği video — yoklama aralığı; çoğu video birkaç dakikada hazır. */
export const FOLLOW_UP_PUBLISHING_SEC = 120;
/**
 * Bundan eski container için takip kurulmaz: takılı bir video DB'yi saatlerce
 * uyanık tutmasın. Böylesini günlük `publish-scheduled` cron'unun takılı-video
 * dalı bitirir (container 24 saatte zaten geçersizleşiyor).
 */
export const FOLLOW_UP_PUBLISHING_MAX_AGE_MS = 30 * 60 * 1000;

/** Aynı anda en fazla kaç mesaj kurulur (bkz. `syncQueueWakes`). */
const ARM_CONCURRENCY = 6;
/**
 * Mesajı yazılmamış bir satır bu süreden eskiyse yetim sayılır: kuran senkron
 * çoktan bitmiş ya da ölmüş (fonksiyon tavanı 60 sn).
 */
export const ORPHAN_CLAIM_MS = 2 * 60 * 1000;

/** Mesaj gövdesi — imzalı, tick hangi tür uyandırma olduğunu buradan okur. */
export type WakeKind = "slot" | "follow";
export type WakeBody = { kind: WakeKind };

/**
 * Tick'in ham gövdesinden uyandırma türü. Gövdesiz ya da tanınmayan istek
 * (yedek tetikleyicinin GET'i, elle çağrı) `slot` sayılır: yanlışlıkla
 * `follow` saymak R2 temizliğini atlatırdı, tersi yalnızca bir temizlik
 * turu fazladan koşturur.
 */
export function parseWakeKind(rawBody: string): WakeKind {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "follow") {
      return "follow";
    }
  } catch {
    // boş ya da JSON olmayan gövde
  }
  return "slot";
}

/**
 * `[now, now + WAKE_HORIZON_MS]` içindeki bütün slot anları — müşteriler
 * arasında tekilleştirilmiş, artan sırada, saniyeye yuvarlı (`notBefore`
 * saniye; ms farkı iki ayrı uyandırma doğurmasın).
 *
 * Duraklatılmış müşteriler DAHİL: tick vadesi gelen slotuna `SlotRun(paused)`
 * yazıyor ve "o gün neden yayın olmadı" sorusunun cevabı o satır. Uyandırma
 * olmasaydı satır yazılmaz, duraklatma kalkınca slot `skipped` görünürdü.
 */
export function desiredWakeTimes(
  settingsList: Pick<QueueSettings, "slots" | "timezone" | "days">[],
  now: Date
): Date[] {
  const range = { from: now, to: new Date(now.getTime() + WAKE_HORIZON_MS) };
  const seen = new Set<number>();
  for (const settings of settingsList) {
    for (const instant of slotInstants(settings, range)) {
      seen.add(Math.floor(instant.getTime() / 1000) * 1000);
    }
  }
  return [...seen].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * Tick bittiğinde takip uyandırması gerekiyor mu — saniye cinsinden gecikme
 * ya da `null`. Saf; tick'in iki "sonraki tick'e bırakıyorum" dalı eskiden
 * 5 dakikalık döngüye güveniyordu, artık kendi mesajını kurması gerekiyor.
 */
export function followUpDecision(
  stats: { deferred: number },
  publishingContainerTimes: Date[],
  now: Date
): number | null {
  const options: number[] = [];
  if (stats.deferred > 0) options.push(FOLLOW_UP_DEFERRED_SEC);
  const fresh = publishingContainerTimes.some(
    (openedAt) => now.getTime() - openedAt.getTime() <= FOLLOW_UP_PUBLISHING_MAX_AGE_MS
  );
  if (fresh) options.push(FOLLOW_UP_PUBLISHING_SEC);
  return options.length > 0 ? Math.min(...options) : null;
}

export type WakeSyncResult = {
  armed: number;
  cancelled: number;
  failed: number;
  pruned: number;
  /** Doluysa senkron hiç denenmedi (yapılandırma eksik). */
  skipped?: string;
};

/**
 * Kurulmuş uyandırmaları ayarlarla eşitler. ASLA throw etmez — ayar kaydının
 * ya da günlük cron'un yanıtını bozmamalı.
 *
 *   • Eksik an: önce `QueueWake` satırı (P2002 = eşzamanlı başka senkron
 *     kurdu, atla), SONRA QStash mesajı. Sıra bilinçli: tersinde iki senkron
 *     aynı ana iki mesaj atabilirdi. Mesaj atılamazsa satır silinir ki
 *     sonraki senkron yeniden denesin.
 *   • Artık istenmeyen gelecek an (saat değişti): mesaj iptal edilir, satır
 *     silinir. İptal başarısız olsa da satır silinir — kalan mesaj tick'te
 *     "vadesi gelen slot yok" deyip kapanan zararsız bir uyanmaya döner.
 *   • Bir günden eski satırlar budanır.
 */
export async function syncQueueWakes(now: Date = new Date()): Promise<WakeSyncResult> {
  const result: WakeSyncResult = { armed: 0, cancelled: 0, failed: 0, pruned: 0 };
  const client = qstashClient();
  const base = appUrl();
  if (!client || !base) {
    return { ...result, skipped: "QSTASH_TOKEN ya da APP_URL tanımlı değil" };
  }

  // Ayarlar okunmadan ÖNCEKİ an: eşzamanlı bir senkronun (daha yeni ayarı
  // görmüş olabilir) bu arada kurduğu satır bizim eski görüşümüzle "istenmeyen"
  // sayılıp iptal edilmesin. Satırın `createdAt`ı DB saatinde; fark ms düzeyi.
  const startedAt = new Date();
  try {
    const desired = desiredWakeTimes(await findQueueSchedules(), now);
    const desiredMs = new Set(desired.map((at) => at.getTime()));
    const existing = await listWakesFrom(now);
    const existingMs = new Set<number>();
    const orphanBefore = new Date(startedAt.getTime() - ORPHAN_CLAIM_MS);

    for (const row of existing) {
      // Sahiplenilmiş ama mesajı hiç yazılmamış satır: senkron satırı yazıp
      // mesajı atamadan öldü (fonksiyon zaman aşımı) ya da geri alma da
      // patladı. Bırakılırsa o an "kurulu" sayılır ve hiçbir senkron onarmaz —
      // QStash'te mesaj yok, slot sessizce kaçar. Taze olanı başka bir senkron
      // şu an kuruyor olabilir, ona dokunulmaz.
      if (!row.messageId && row.createdAt < orphanBefore) {
        await deleteWake(row.at);
        continue;
      }
      existingMs.add(row.at.getTime());
      if (desiredMs.has(row.at.getTime()) || row.createdAt >= startedAt) continue;
      if (row.messageId) {
        try {
          await client.messages.cancel(row.messageId);
        } catch (error) {
          console.error("[queue-wake] uyandırma iptal edilemedi:", (error as Error).message);
        }
      }
      await deleteWake(row.at);
      result.cancelled += 1;
    }

    const arm = async (at: Date) => {
      if (!(await claimWake(at))) return;
      try {
        const res = await client.publishJSON({
          url: `${base}/api/queue/tick`,
          body: { kind: "slot" } satisfies WakeBody,
          notBefore: Math.floor(at.getTime() / 1000),
          retries: 3,
        });
        await setWakeMessageId(at, res.messageId);
        result.armed += 1;
      } catch (error) {
        console.error("[queue-wake] uyandırma kurulamadı:", (error as Error).message);
        result.failed += 1;
        await deleteWake(at).catch(() => undefined);
      }
    };
    // Gruplar hâlinde paralel: ilk kurulumda 6 gün × 6 slot = 36 istek. Sırayla
    // gitseler senkronu satır içi çağıran ayar kaydı saniyelerce bekler; hepsi
    // birden gitse DB bağlantı havuzu ve QStash'e anlık yük olur.
    const missing = desired.filter((at) => !existingMs.has(at.getTime()));
    for (let i = 0; i < missing.length; i += ARM_CONCURRENCY) {
      await Promise.all(missing.slice(i, i + ARM_CONCURRENCY).map(arm));
    }

    result.pruned = await pruneWakesBefore(new Date(now.getTime() - DAY_MS));
  } catch (error) {
    console.error("[queue-wake] senkron patladı:", error);
    result.failed += 1;
  }

  if (result.failed > 0) {
    // Ufuk 6 gün olduğu için tek bir başarısız senkron slot kaçırtmaz; ama
    // art arda başarısızlık sessiz kalırsa kuyruk günler sonra durur.
    await sendAlert("queue:wake:sync", "Kuyruk uyandırmaları kurulamadı", {
      failed: result.failed,
      armed: result.armed,
    });
  }
  return result;
}

/**
 * Tek seferlik takip uyandırması. Aynı pencerede birden çok istek QStash'in
 * tekilleştirmesiyle (10 dk) tek mesaja iner: kova `delaySec` uzunluğunda,
 * yani eşzamanlı iki tick aynı takibi iki kez kurmaz. Throw etmez.
 */
export async function scheduleFollowUp(delaySec: number, reason: string): Promise<boolean> {
  const client = qstashClient();
  const base = appUrl();
  if (!client || !base) return false;
  const bucket = Math.floor(Date.now() / 1000 / delaySec);
  try {
    await client.publishJSON({
      url: `${base}/api/queue/tick`,
      body: { kind: "follow" } satisfies WakeBody,
      delay: delaySec,
      deduplicationId: `follow-${delaySec}-${bucket}`,
      retries: 3,
    });
    return true;
  } catch (error) {
    console.error(`[queue-wake] takip uyandırması kurulamadı (${reason}):`, (error as Error).message);
    await sendAlert("queue:wake:follow", "Kuyruk takip uyandırması kurulamadı", { reason });
    return false;
  }
}
