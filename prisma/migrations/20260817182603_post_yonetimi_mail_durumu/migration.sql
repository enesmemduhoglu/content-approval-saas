-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "approvalEmailError" TEXT,
ADD COLUMN     "approvalEmailSent" BOOLEAN,
ADD COLUMN     "approvalEmailSentAt" TIMESTAMP(3);
