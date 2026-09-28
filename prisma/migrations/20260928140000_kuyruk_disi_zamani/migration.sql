-- V9: portal videosunun kuyruk dışına çıktığı an. Kuyruk dışı video bu andan
-- 3 gün sonra kendiliğinden silinir (src/lib/media-retention.ts).
ALTER TABLE "Post" ADD COLUMN "outsideAt" TIMESTAMP(3);

-- Backfill: göç anında zaten kuyruk dışında duran portal videoları. Gerçek
-- çıkış anı bilinmiyor; NOW() yazılır ki hiçbiri merge'le birlikte hemen
-- silinmesin, müşteri tam 3 günlük sayaç görsün. Koşul `DELETABLE_OUTSIDE`
-- ile aynı (client-scoped-db.ts): taslak, yayınlanan ve yayınlanmakta olan
-- videolar kapsam dışı.
UPDATE "Post"
SET "outsideAt" = NOW()
WHERE "source" = 'portal'
  AND "queuePosition" IS NULL
  AND "status" IN ('pending', 'approved', 'rejected')
  AND "publishStatus" IN ('idle', 'failed');
