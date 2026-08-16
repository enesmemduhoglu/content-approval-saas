-- AlterEnum
-- Additive: mevcut değerlere dokunulmaz, yalnızca yeni değer eklenir.
-- Postgres 12+ ADD VALUE'yu transaction içinde kabul eder (değer aynı
-- transaction'da KULLANILMADIĞI sürece) — burada sadece ekleniyor.
ALTER TYPE "PublishStatus" ADD VALUE 'duplicate';
