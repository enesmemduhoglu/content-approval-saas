-- V12 (K36): portaldan reklam görseli yayını.
--
-- Toplayıcı: yeni kolonların hepsi nullable ya da varsayılanlı, mevcut
-- satırlarda reklam kapalı (`adsEnabled = false`) ve her SlotRun `video`.
-- PR'a push edildiğinde preview build bunu prod'a uygular (CLAUDE.md) ve
-- canlıdaki ESKİ kod bir süre bu şemayla çalışır: eski kod `kind` vermeden
-- yazar → `video`, yeni kolonları hiç görmez.
--
-- UNIQUE değişimi GENİŞLETİR, daraltmaz: (clientId, slotAt) tekil olan her
-- satır (clientId, slotAt, kind) için de tekil — mevcut veride çakışma
-- olamaz. Sıra Prisma'nın ürettiğinin TERSİ: önce yeni indeks, sonra eskisi
-- düşer; arada tick'in `claimSlotRun` INSERT'ini koruyan hiçbir indeksin
-- olmadığı bir an kalmasın.
--
-- Geri alma (yeni kod geri çekildikten SONRA):
--   CREATE UNIQUE INDEX "SlotRun_clientId_slotAt_key" ON "SlotRun"("clientId", "slotAt");
--     -- yalnızca aynı ana düşen video+reklam satırı yoksa geçer; varsa reklam satırı silinir
--   DROP INDEX "SlotRun_clientId_slotAt_kind_key";
--   ALTER TABLE "SlotRun" DROP COLUMN "kind"; DROP TYPE "SlotKind";
--   ALTER TABLE "Post" DROP COLUMN "isAd", DROP COLUMN "imageKey";
--   ALTER TABLE "PublishSettings" DROP COLUMN "adsEnabled", ... ;
-- Kaybolan veri yalnızca reklam ayarları ve reklam satırlarının işareti
-- (reklam postları sıradan, kuyruk dışı post olarak kalır).

-- CreateEnum
CREATE TYPE "SlotKind" AS ENUM ('video', 'ad');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "imageKey" TEXT,
ADD COLUMN     "isAd" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PublishSettings" ADD COLUMN     "adCaption" TEXT,
ADD COLUMN     "adCountFrom" TIMESTAMP(3),
ADD COLUMN     "adMaxGap" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "adMinGap" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "adNextAfter" INTEGER,
ADD COLUMN     "adSlot" TEXT NOT NULL DEFAULT '21:00',
ADD COLUMN     "adsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SlotRun" ADD COLUMN     "kind" "SlotKind" NOT NULL DEFAULT 'video';

-- CreateIndex (eskisini düşürmeden ÖNCE — yukarıya bak)
CREATE UNIQUE INDEX "SlotRun_clientId_slotAt_kind_key" ON "SlotRun"("clientId", "slotAt", "kind");

-- DropIndex
DROP INDEX "SlotRun_clientId_slotAt_key";
