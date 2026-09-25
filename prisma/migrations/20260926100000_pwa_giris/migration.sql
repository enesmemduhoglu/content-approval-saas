-- V7a — PWA temeli ve kodla giriş (docs/video-kuyrugu/V7-pwa.md §4).
-- Yalnızca toplayıcı: yeni kolonların hepsi nullable ya da varsayılanlı, mevcut
-- satırlar olduğu gibi kalır. `attempts` NOT NULL ama DEFAULT 0 — Postgres
-- mevcut satırları varsayılanla doldurur, backfill gerekmez.
-- Geri alma: dört `Client` kolonu ve iki `ClientLoginToken` kolonu DROP edilir;
-- kaybolan veri yalnızca uygulama adı/ikon ayarı ve (en fazla 15 dk ömürlü)
-- kod hash'leri.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "appIconBase" TEXT,
ADD COLUMN     "appName" TEXT,
ADD COLUMN     "appShortName" TEXT,
ADD COLUMN     "appThemeColor" TEXT;

-- AlterTable
ALTER TABLE "ClientLoginToken" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" TEXT;
