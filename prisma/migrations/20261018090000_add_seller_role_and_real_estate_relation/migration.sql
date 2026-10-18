-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SELLER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "cpf" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "realEstateId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_realEstateId_idx" ON "User"("realEstateId");
CREATE INDEX IF NOT EXISTS "User_cpf_idx" ON "User"("cpf");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_realEstateId_fkey'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_realEstateId_fkey" FOREIGN KEY ("realEstateId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
