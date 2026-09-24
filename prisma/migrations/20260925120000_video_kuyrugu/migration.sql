-- CreateEnum
CREATE TYPE "SlotOutcome" AS ENUM ('published', 'failed', 'empty', 'skipped', 'paused');

-- CreateEnum
CREATE TYPE "PostSource" AS ENUM ('agency', 'portal');

-- CreateEnum
CREATE TYPE "CaptionStatus" AS ENUM ('pending', 'generating', 'ready', 'failed');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "captionStyle" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "captionError" TEXT,
ADD COLUMN     "captionStatus" "CaptionStatus",
ADD COLUMN     "frameKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "queuePosition" DOUBLE PRECISION,
ADD COLUMN     "slotAt" TIMESTAMP(3),
ADD COLUMN     "source" "PostSource" NOT NULL DEFAULT 'agency',
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "videoKey" TEXT;

-- CreateTable
CREATE TABLE "PublishSettings" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "slots" TEXT[] DEFAULT ARRAY['19:00']::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "notifyEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlotRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "slotAt" TIMESTAMP(3) NOT NULL,
    "postId" TEXT,
    "outcome" "SlotOutcome",
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientUser" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientLoginToken" (
    "id" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientLoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishSettings_clientId_key" ON "PublishSettings"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SlotRun_clientId_slotAt_key" ON "SlotRun"("clientId", "slotAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientUser_email_key" ON "ClientUser"("email");

-- CreateIndex
CREATE INDEX "ClientUser_clientId_idx" ON "ClientUser"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientLoginToken_tokenHash_key" ON "ClientLoginToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ClientLoginToken_clientUserId_idx" ON "ClientLoginToken"("clientUserId");

-- CreateIndex
CREATE INDEX "Post_clientId_queuePosition_idx" ON "Post"("clientId", "queuePosition");

-- AddForeignKey
ALTER TABLE "PublishSettings" ADD CONSTRAINT "PublishSettings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotRun" ADD CONSTRAINT "SlotRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientUser" ADD CONSTRAINT "ClientUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLoginToken" ADD CONSTRAINT "ClientLoginToken_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "ClientUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

