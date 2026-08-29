-- Reels (video) desteği. Tamamı ekleme — mevcut satırlarda hepsi NULL kalır,
-- yani bugünkü görsel/karusel akışı bu migration'dan etkilenmez.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "containerAt" TIMESTAMP(3),
ADD COLUMN     "igContainerId" TEXT,
ADD COLUMN     "videoUrl" TEXT;
