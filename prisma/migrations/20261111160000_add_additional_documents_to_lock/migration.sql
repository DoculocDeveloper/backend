-- AlterTable
ALTER TABLE "OragoConsultLock" ADD COLUMN IF NOT EXISTS "additionalDocuments" TEXT;
ALTER TABLE "OragoConsultLock" ADD COLUMN IF NOT EXISTS "additionalOragoAnalysisIds" TEXT;
