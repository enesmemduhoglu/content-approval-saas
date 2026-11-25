-- V12c: reklam havuzunun sırası (portalda basılı tutup sürükleyerek değişir).
--
-- Toplayıcı: yalnızca nullable kolon + backfill. Canlıdaki ESKİ kod kolonu
-- görmez ve havuzu `createdAt`/`sourceName` ile sıralamaya devam eder; yeni
-- kodun sırası backfill sayesinde onunla aynı başlar, preview build'in göçü
-- prod'a erken uygulaması (CLAUDE.md) gözle görülür bir şey değiştirmez.
--
-- Backfill müşteri başına mevcut yükleme sırasını 1024'lük adımlarla yazar
-- (`queue.ts > POSITION_STEP` ile aynı). Furkan'ın 56 reklamı betikle TEK TEK
-- yazıldığı için `createdAt` sırası verilen sıradır; aynı milisaniyede doğmuş
-- satırlarda `sourceName` sayısal karşılaştırmayı SQL'de birebir kurmak yerine
-- `id` yedeği yeterli (taslak toplu yüklemede seçim sırası zaten `createdAt`).
--
-- Geri alma: ALTER TABLE "Post" DROP COLUMN "adPosition";  (kaybolan yalnızca
-- portalda elle verilmiş sıra; havuz yükleme sırasına döner)

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "adPosition" DOUBLE PRECISION;

-- Backfill
UPDATE "Post" AS p
SET "adPosition" = s.rn * 1024
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "clientId" ORDER BY "createdAt", id) AS rn
  FROM "Post"
  WHERE "isAd" = true
) AS s
WHERE p.id = s.id;
