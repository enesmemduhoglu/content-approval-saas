-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('idle', 'publishing', 'published', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "instagramAccessToken" TEXT,
ADD COLUMN     "instagramTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "instagramUserId" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "igMediaId" TEXT,
ADD COLUMN     "igPermalink" TEXT,
ADD COLUMN     "publishError" TEXT,
ADD COLUMN     "publishStatus" "PublishStatus" NOT NULL DEFAULT 'idle',
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PostImage" ADD COLUMN     "altText" TEXT;

-- CreateIndex
CREATE INDEX "Post_externalRef_idx" ON "Post"("externalRef");
