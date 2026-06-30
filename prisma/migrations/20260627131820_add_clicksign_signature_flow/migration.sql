/*
  Warnings:

  - A unique constraint covering the columns `[clicksignEnvelopeId]` on the table `Contract` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ContractSignatureStatus" AS ENUM ('NOT_SENT', 'ENVELOPE_CREATED', 'SENT', 'PARTIALLY_SIGNED', 'SIGNED', 'REFUSED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "ContractSignerRole" AS ENUM ('TENANT', 'REAL_ESTATE', 'DOCULOC');

-- CreateEnum
CREATE TYPE "ContractSignerStatus" AS ENUM ('PENDING', 'SENT', 'SIGNED', 'REFUSED', 'CANCELLED', 'ERROR');

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "clicksignDocumentId" TEXT,
ADD COLUMN     "clicksignEnvelopeId" TEXT,
ADD COLUMN     "sentToSignatureAt" TIMESTAMP(3),
ADD COLUMN     "signatureError" TEXT,
ADD COLUMN     "signatureStatus" "ContractSignatureStatus" NOT NULL DEFAULT 'NOT_SENT',
ADD COLUMN     "signedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ContractSigner" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "role" "ContractSignerRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "document" TEXT,
    "clicksignSignerId" TEXT,
    "status" "ContractSignerStatus" NOT NULL DEFAULT 'PENDING',
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractSigner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClicksignWebhookEvent" (
    "id" TEXT NOT NULL,
    "contractId" TEXT,
    "eventName" TEXT,
    "clicksignEnvelopeId" TEXT,
    "clicksignDocumentId" TEXT,
    "clicksignSignerId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClicksignWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractSigner_contractId_idx" ON "ContractSigner"("contractId");

-- CreateIndex
CREATE INDEX "ContractSigner_clicksignSignerId_idx" ON "ContractSigner"("clicksignSignerId");

-- CreateIndex
CREATE INDEX "ContractSigner_status_idx" ON "ContractSigner"("status");

-- CreateIndex
CREATE INDEX "ClicksignWebhookEvent_contractId_idx" ON "ClicksignWebhookEvent"("contractId");

-- CreateIndex
CREATE INDEX "ClicksignWebhookEvent_clicksignEnvelopeId_idx" ON "ClicksignWebhookEvent"("clicksignEnvelopeId");

-- CreateIndex
CREATE INDEX "ClicksignWebhookEvent_eventName_idx" ON "ClicksignWebhookEvent"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_clicksignEnvelopeId_key" ON "Contract"("clicksignEnvelopeId");

-- CreateIndex
CREATE INDEX "Contract_signatureStatus_idx" ON "Contract"("signatureStatus");

-- AddForeignKey
ALTER TABLE "ContractSigner" ADD CONSTRAINT "ContractSigner_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClicksignWebhookEvent" ADD CONSTRAINT "ClicksignWebhookEvent_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
