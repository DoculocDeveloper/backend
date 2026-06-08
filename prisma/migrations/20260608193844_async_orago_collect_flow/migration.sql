/*
  Warnings:

  - A unique constraint covering the columns `[document]` on the table `OragoConsultLock` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX IF EXISTS "OragoConsultLock_document_idx";

-- AlterTable
ALTER TABLE "OragoConsultLock" ADD COLUMN     "condominiumValue" DECIMAL(65,30),
ADD COLUMN     "feesValue" DECIMAL(65,30),
ADD COLUMN     "rentValue" DECIMAL(65,30);

-- CreateIndex
CREATE UNIQUE INDEX "OragoConsultLock_document_key" ON "OragoConsultLock"("document");
