-- V8 (K28) — yayın günleri. ISO hafta günü (1 = Pazartesi … 7 = Pazar),
-- müşterinin saat dilimine göre yerel gün.
--
-- Toplayıcı göç: default'lu ADD COLUMN mevcut satırları da varsayılanla
-- doldurur (Postgres 11+ sabit default'u katalogda tutar, tabloyu yeniden
-- yazmaz). Yani göçten önce kaydedilmiş her ayar aynen "her gün" yayınlamaya
-- devam eder; ayrı bir backfill gerekmez. Eski veriyle sınandı.

-- AlterTable
ALTER TABLE "PublishSettings" ADD COLUMN     "days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::INTEGER[];
