-- AlterTable
ALTER TABLE "OragoConsultLock" ADD COLUMN IF NOT EXISTS "secondDocument" TEXT;
ALTER TABLE "OragoConsultLock" ADD COLUMN IF NOT EXISTS "secondOragoAnalysisId" TEXT;

-- AlterTable
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "isJointApplication" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "totalPresumedIncome" DECIMAL(65, 30);

-- AlterTable
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "oragoAnalysisId" TEXT;
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "oragoData" TEXT;
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "presumedIncome" DECIMAL(65, 30);
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "incomePercentage" DECIMAL(65, 30);
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "isPrimaryIncome" BOOLEAN DEFAULT false;
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "recommendation" "RecommendationStatus";
ALTER TABLE "RentalApplicationTenant" ADD COLUMN IF NOT EXISTS "decisionReasons" TEXT;
