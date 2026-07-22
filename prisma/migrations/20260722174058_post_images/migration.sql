-- Çoklu görsel (D3.3): Post.imageUrl -> PostImage tablosu.
-- Veri kaybını önlemek için sıra: tablo oluştur -> mevcut görselleri taşı -> kolonu düşür.

-- CreateTable
CREATE TABLE "PostImage" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostImage_postId_idx" ON "PostImage"("postId");

-- AddForeignKey
ALTER TABLE "PostImage" ADD CONSTRAINT "PostImage_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DataMigration: mevcut tek görselleri taşı (id: postId türevli, deterministik ve benzersiz)
INSERT INTO "PostImage" ("id", "postId", "url", "sortOrder", "createdAt")
SELECT 'img_' || substr(md5("id"), 1, 21), "id", "imageUrl", 0, "createdAt"
FROM "Post";

-- AlterTable
ALTER TABLE "Post" DROP COLUMN "imageUrl";
