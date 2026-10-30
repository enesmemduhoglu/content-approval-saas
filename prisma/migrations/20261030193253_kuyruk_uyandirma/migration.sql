-- V11: kurulmuş tek seferlik QStash uyandırmaları. Yalnızca yeni tablo —
-- toplayıcı; eski kod tabloyu görmez, preview build'in prod'a erken
-- uygulaması (CLAUDE.md) güvenli. Geri alma: DROP TABLE "QueueWake"; (veri
-- yalnızca yeniden üretilebilir zamanlama kaydı).
-- CreateTable
CREATE TABLE "QueueWake" (
    "at" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueWake_pkey" PRIMARY KEY ("at")
);
