-- F6 — ajans başına tek kullanıcı sınırını kaldıran göç.
--
-- ┌─ BU MIGRATION'IN EN KRİTİK PARÇASI EN ALTTA ─────────────────────────────┐
-- │ Şema değişikliği tek başına PROD'U KIRAR: `auth.ts` artık `Agency`'yi    │
-- │ değil `AgencyMember`'ı çözüyor, yani üye satırı olmayan bir ajansın      │
-- │ sahibi deploy'dan sonra kendi verisine (12 post / 1 müşteri) GİREMEZ —   │
-- │ ve girişte kendisine bomboş yeni bir ajans açılır. Aşağıdaki backfill    │
-- │ tam olarak bunu engelliyor ve isteğe bağlı değil.                        │
-- └──────────────────────────────────────────────────────────────────────────┘

-- CreateEnum
CREATE TYPE "AgencyRole" AS ENUM ('owner', 'member');

-- DropIndex
-- `Agency.email` artık kimlik değil, yalnızca bildirim adresi. Uniqueliği
-- korumak, aynı e-postanın ikinci bir ajansta görünmesi gereken meşru
-- senaryolarda (ajanstan çıkarılan kurucunun tekrar giriş yapması) girişi
-- unique ihlaliyle düşürürdü. Kolon ve veri duruyor, yalnızca kısıt kalkıyor.
DROP INDEX "Agency_email_key";

-- AlterTable
-- `Agency.googleId` DÜŞÜRÜLMÜYOR (geri dönüşü olmayan veri kaybı olurdu ve
-- rollback'i kırardı), yalnızca NULLABLE yapılıyor: yeni ajanslar artık bu
-- alanı doldurmuyor. Bkz. schema.prisma'daki gerekçe.
ALTER TABLE "Agency" ALTER COLUMN "googleId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AgencyMember" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "AgencyRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyInvite" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AgencyRole" NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyMember_googleId_key" ON "AgencyMember"("googleId");

-- CreateIndex
CREATE INDEX "AgencyMember_agencyId_idx" ON "AgencyMember"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyMember_email_idx" ON "AgencyMember"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyInvite_token_key" ON "AgencyInvite"("token");

-- CreateIndex
CREATE INDEX "AgencyInvite_agencyId_idx" ON "AgencyInvite"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyInvite_email_idx" ON "AgencyInvite"("email");

-- AddForeignKey
ALTER TABLE "AgencyMember" ADD CONSTRAINT "AgencyMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyInvite" ADD CONSTRAINT "AgencyInvite_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────── VERİ GÖÇÜ (elle eklendi) ────────────────────────
-- Mevcut HER ajans için `owner` rolünde bir üye üret. Kaynak, ajansın kendi
-- `googleId`/`email` değerleri — yani "bugün bu ajansa giren kişi" aynen
-- yarın da girebilsin diye.
--
-- `id` neden cuid değil: cuid'i SQL'de üretemiyoruz. Prisma bu alanı yalnızca
-- uygulama katmanında dolduruyor, kolonun kendisi düz TEXT — biçim zorlaması
-- yok. `gen_random_uuid()` PG13+ ile çekirdekte geliyor (prod ve yerel PG16).
-- `mig_` öneki bilinçli: bir gün "bu satır nereden geldi" diye sorulduğunda
-- göçten geldiği tek bakışta görülsün.
--
-- WHERE koşulları savunmacı: `googleId IS NOT NULL` (kolon bu migration'dan
-- ÖNCE NOT NULL olduğu için bugün hepsi dolu, ama migration ileride boş bir
-- DB'de de koşabilir) ve NOT EXISTS (migration'ın tekrar koşturulması
-- durumunda mükerrer üye üretmesin — idempotent).
INSERT INTO "AgencyMember" ("id", "agencyId", "googleId", "email", "name", "role", "createdAt")
SELECT
    'mig_' || replace(gen_random_uuid()::text, '-', ''),
    a."id",
    a."googleId",
    a."email",
    a."name",
    'owner'::"AgencyRole",
    a."createdAt"
FROM "Agency" a
WHERE a."googleId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "AgencyMember" m WHERE m."agencyId" = a."id"
  );
