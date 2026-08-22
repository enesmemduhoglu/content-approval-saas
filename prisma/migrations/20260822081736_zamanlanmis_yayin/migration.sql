-- AlterEnum
ALTER TYPE "PublishStatus" ADD VALUE 'scheduled';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "publishAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Post_publishStatus_publishAt_idx" ON "Post"("publishStatus", "publishAt");
