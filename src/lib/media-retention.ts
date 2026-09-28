import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { DELETABLE_OUTSIDE, deleteOutsideVideo } from "@/lib/client-scoped-db";
import { deleteOwnedObjects } from "@/lib/r2-cleanup";
import { r2Configured } from "@/lib/storage-r2";
import { OUTSIDE_TTL_MS, PUBLISHED_VIDEO_TTL_MS } from "@/lib/retention-rules";

/**
 * Video kuyruğu (V9) — R2 depolama temizliği. İki iş:
 *
 *   • Yayınlanan video (`published`/`duplicate`) yayından 2 gün sonra
 *     "arşivlenir": mp4 ve ilk kare DIŞINDAKİ kareler R2'den silinir, satır
 *     kalır (geçmiş ve mükerrer yayın koruması ona bakıyor). İlk kare kapak
 *     olarak geçmiş listesinde görünmeye devam eder. Instagram'da kopyası var.
 *   • Kuyruk dışı video (reddedilen ya da çıkarılan) `outsideAt`ten 3 gün
 *     sonra tamamen silinir: satır + tüm nesneler, portalın "Sil" düğmesiyle
 *     aynı yoldan (`deleteOutsideVideo`).
 *
 * Neden: R2'nin ücretsiz katmanı 10 GB; video ~50 MB. Temizliksiz bucket
 * birkaç ayda dolar (K30).
 *
 * Sıra her zaman DB önce, R2 sonra: R2 hatası en kötü öksüz nesne bırakır
 * (`scripts/r2-denetim.mjs` yakalar); tersi, portalda kırık bir video bırakırdı.
 *
 * Saatte bir kuyruk tick'inden, günde bir `pending-reminders` cron'undan
 * çağrılır (ikincisi emniyet ağı). İki koşu çakışsa da her adım koşullu
 * yazım olduğu için iş bir kez yapılır. ASLA throw etmez (`sendAlert` deseni):
 * temizliğin patlaması yayını ya da hatırlatmaları düşürmemeli.
 *
 * `getClientScopedDb` BİLEREK yok: işin oturumu yok, iş müşteriler üstü;
 * dışarıya veri çıkmıyor. Her sorgu `source: portal` koşullu.
 */

/**
 * Koşu başına üst sınır (iş başına). Tick'in 60 sn tavanı var ve temizlik
 * yayından sonra koşuyor; kalanlar bir sonraki koşuya kalır.
 */
const RUN_LIMIT = 20;

const DONE = { in: ["published" as const, "duplicate" as const] };

export type MediaRetentionStats = {
  archived: number;
  purged: number;
  failed: number;
  skipped?: "r2_not_configured";
  error?: true;
};

/** Saatte bir: tick her 5 dakikada gelir, yalnızca saatin ilk tick'i temizlik yapar. */
export function retentionDue(now: Date): boolean {
  return now.getUTCMinutes() < 5;
}

export async function runMediaRetention(now: Date = new Date()): Promise<MediaRetentionStats> {
  const stats: MediaRetentionStats = { archived: 0, purged: 0, failed: 0 };
  try {
    // R2 yoksa hiçbir şey silinmez: satırdan anahtarı düşürüp nesneyi
    // bırakmak, env geçici olarak eksikken R2'de sahipsiz çöp üretirdi.
    if (!r2Configured()) return { ...stats, skipped: "r2_not_configured" };
    await archivePublished(now, stats);
    await purgeOutside(now, stats);
    if (stats.failed > 0) {
      await sendAlert("cron:media-retention:failed", "Video depolama temizliğinde hata", {
        archived: stats.archived,
        purged: stats.purged,
        failed: stats.failed,
      });
    }
    return stats;
  } catch (error) {
    console.error("[media-retention] çöktü:", error);
    await sendAlert("cron:media-retention:crash", "Video depolama temizliği çöktü", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...stats, error: true };
  }
}

async function archivePublished(now: Date, stats: MediaRetentionStats): Promise<void> {
  const cutoff = new Date(now.getTime() - PUBLISHED_VIDEO_TTL_MS);
  const rows = await db.post.findMany({
    where: {
      source: "portal",
      publishStatus: DONE,
      videoKey: { not: null },
      // `duplicate`te `publishedAt` boş kalabiliyor; son değişiklik yedek
      // (`videoArchivesAt` ekrandaki sayacı aynı kuralla hesaplıyor).
      OR: [{ publishedAt: { lt: cutoff } }, { publishedAt: null, updatedAt: { lt: cutoff } }],
    },
    orderBy: { updatedAt: "asc" },
    take: RUN_LIMIT,
    select: { id: true, clientId: true, videoKey: true, frameKeys: true },
  });

  for (const row of rows) {
    try {
      // Koşul okunan anahtar: arada başka bir koşu arşivlediyse sayaç 0 ve
      // nesneler ikinci kez silinmeye çalışılmaz.
      const updated = await db.post.updateMany({
        where: { id: row.id, source: "portal", publishStatus: DONE, videoKey: row.videoKey },
        data: { videoKey: null, frameKeys: row.frameKeys.slice(0, 1) },
      });
      if (updated.count !== 1) continue;
      const removed = await deleteOwnedObjects(
        row.clientId,
        [row.videoKey, ...row.frameKeys.slice(1)],
        "media-retention"
      );
      stats.archived += 1;
      if (removed.failed > 0) stats.failed += 1;
    } catch (error) {
      stats.failed += 1;
      console.error(`[media-retention] arşivlenemedi (post=${row.id}):`, (error as Error).message);
    }
  }
}

async function purgeOutside(now: Date, stats: MediaRetentionStats): Promise<void> {
  const cutoff = new Date(now.getTime() - OUTSIDE_TTL_MS);
  const expired = { outsideAt: { lt: cutoff } };
  const rows = await db.post.findMany({
    where: {
      source: "portal",
      ...DELETABLE_OUTSIDE,
      ...expired,
    },
    orderBy: { outsideAt: "asc" },
    take: RUN_LIMIT,
    select: { id: true, clientId: true },
  });

  for (const row of rows) {
    try {
      // "Süresi dolmuş" koşulu silmenin kendisinde de var: müşteri video
      // geri alıp yeniden çıkardıysa `outsideAt` tazelenmiştir, silinmez.
      const keys = await deleteOutsideVideo(row.id, row.clientId, expired);
      if (!keys) continue;
      const removed = await deleteOwnedObjects(
        row.clientId,
        [keys.videoKey, ...keys.frameKeys],
        "media-retention"
      );
      stats.purged += 1;
      if (removed.failed > 0) stats.failed += 1;
    } catch (error) {
      stats.failed += 1;
      console.error(`[media-retention] silinemedi (post=${row.id}):`, (error as Error).message);
    }
  }
}
