-- CreateEnum
CREATE TYPE "RevisionActor" AS ENUM ('client', 'agency');

-- CreateEnum
CREATE TYPE "RevisionEvent" AS ENUM ('revision_requested', 'resubmitted');

-- AlterEnum
ALTER TYPE "PostStatus" ADD VALUE 'revision_requested';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "revisionRound" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PostRevision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "actor" "RevisionActor" NOT NULL,
    "event" "RevisionEvent" NOT NULL,
    "message" TEXT,
    "caption" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostRevision_postId_idx" ON "PostRevision"("postId");

-- AddForeignKey
ALTER TABLE "PostRevision" ADD CONSTRAINT "PostRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
