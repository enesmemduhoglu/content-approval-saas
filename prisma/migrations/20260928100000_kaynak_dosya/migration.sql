-- Portal yüklemesinin kaynak dosyası (2026-09-28 analizi): aynı videonun
-- ikinci kez yüklenmesini seçim anında yakalamak için (bkz. schema.prisma
-- Post.sourceSize). Toplayıcı ve boş olabilen: eski satırlar NULL kalır,
-- onlar için uyarı çıkmaz; backfill yok.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "sourceName" TEXT,
ADD COLUMN     "sourceSize" INTEGER;
