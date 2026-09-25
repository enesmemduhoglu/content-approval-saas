import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { FRAME_COUNT } from "@/lib/portal-validation";
import {
  abortMultipartUpload,
  deleteObject,
  frameKey,
  keyBelongsToClient,
  r2Configured,
} from "@/lib/storage-r2";

/**
 * Video kuyruğu (V7b) — yarıda bırakılmış yüklemelerin günlük temizliği.
 *
 * Portal taslağı (`status: draft`) yükleme bitince `pending`e döner; 24
 * saattir hâlâ `draft` olan taslak terk edilmiştir. Geride üç şey kalır:
 *   • R2'de tamamlanmamış çok parçalı yükleme (nesne olarak görünmez ama yer
 *     kaplar) → `AbortMultipartUpload`,
 *   • tek PUT'la yarım/yüklenmiş video ve kareler → silinir,
 *   • taslak satır (günlük yükleme tavanını da yiyor) → silinir.
 * 24 saat: kaldığı yerden devam telefonda uzun bir aradan sonra bile mümkün
 * kalsın, ama çöp birikmesin. R2 bucket lifecycle kuralı ("tamamlanmamış çok
 * parçalı yüklemeleri 1 gün sonra iptal et") ikinci katman — elle kurulur.
 *
 * `pending-reminders` günlük cron'undan çağrılır (Hobby planı cron sayısı ve
 * sıklığı kısıtlı; bkz. CLAUDE.md). ASLA throw etmez (`sendAlert` deseni):
 * temizliğin patlaması cron'daki hatırlatmaları düşürmemeli.
 *
 * `getClientScopedDb` BİLEREK yok: cron'un oturumu yok, iş müşteriler üstü;
 * dışarıya veri çıkmıyor. Her silme yine `source: portal` + `status: draft`
 * koşullu — tamamlanmış bir videoya bu yoldan dokunulamaz.
 */

export const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;
/**
 * Koşu başına üst sınır. Cron 60 sn'de kesiliyor ve aynı fonksiyonda kuyruk
 * özeti de koşuyor; kalan taslaklar ertesi gece alınır.
 */
const RUN_LIMIT = 50;

export type DraftCleanupStats = {
  checked: number;
  deleted: number;
  aborted: number;
  failed: number;
  skipped?: "r2_not_configured";
  error?: true;
};

export async function cleanupStaleDrafts(now: Date = new Date()): Promise<DraftCleanupStats> {
  const stats: DraftCleanupStats = { checked: 0, deleted: 0, aborted: 0, failed: 0 };
  try {
    // R2 yoksa hiçbir şey silinmez: taslağı silip nesnesini bırakmak, env
    // geçici olarak eksikken R2'de sahipsiz çöp üretirdi.
    if (!r2Configured()) return { ...stats, skipped: "r2_not_configured" };

    const drafts = await db.post.findMany({
      where: {
        source: "portal",
        status: "draft",
        createdAt: { lt: new Date(now.getTime() - STALE_DRAFT_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: RUN_LIMIT,
      select: { id: true, clientId: true, videoKey: true, uploadId: true },
    });
    stats.checked = drafts.length;

    for (const draft of drafts) {
      try {
        // Anahtar müşterinin önekinde değilse (olmamalı) R2'ye hiç dokunulmaz;
        // satır yine silinir — başka bir müşterinin nesnesini silmektense
        // öksüz bir nesne bırakmak ehven.
        const ownKey = draft.videoKey && keyBelongsToClient(draft.videoKey, draft.clientId);
        if (ownKey && draft.uploadId) {
          // Başarısızsa (R2 hatası) THROW eder ve taslak silinmez: kimlik
          // kaybolursa parçalar ancak lifecycle kuralıyla gider. Ertesi gece
          // yeniden denenir.
          await abortMultipartUpload(draft.videoKey!, draft.uploadId);
          stats.aborted += 1;
        }
        if (ownKey) {
          await Promise.all([
            deleteObject(draft.videoKey!),
            ...Array.from({ length: FRAME_COUNT }, (_, i) =>
              deleteObject(frameKey(draft.clientId, draft.id, i))
            ),
          ]);
        }
        const removed = await db.post.deleteMany({
          where: { id: draft.id, source: "portal", status: "draft" },
        });
        stats.deleted += removed.count;
      } catch (error) {
        stats.failed += 1;
        console.error(
          `[draft-cleanup] taslak temizlenemedi (post=${draft.id}):`,
          (error as Error).message
        );
      }
    }

    if (stats.failed > 0) {
      await sendAlert("cron:draft-cleanup:failed", "Yarım kalan yükleme temizliğinde hata", {
        checked: stats.checked,
        failed: stats.failed,
      });
    }
    return stats;
  } catch (error) {
    console.error("[draft-cleanup] çöktü:", error);
    await sendAlert("cron:draft-cleanup:crash", "Yarım kalan yükleme temizliği çöktü", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...stats, error: true };
  }
}
