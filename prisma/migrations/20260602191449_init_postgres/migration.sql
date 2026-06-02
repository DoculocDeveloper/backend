-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'REAL_ESTATE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CPF', 'CNPJ');

-- CreateEnum
CREATE TYPE "AutomaticDecisionStatus" AS ENUM ('APPROVED', 'REJECTED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('RECOMMENDED', 'NOT_RECOMMENDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RentalApplicationStatus" AS ENUM ('CONSULTED', 'WAITING_CONTRACT_DATA', 'WAITING_ADMIN_CONTRACT', 'CONTRACT_GENERATED', 'REJECTED', 'CONTESTED', 'ADMIN_REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdminDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContestStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING', 'GENERATED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreditLedgerType" AS ENUM ('INITIAL_GRANT', 'ADMIN_SET', 'ADMIN_INCREMENT', 'ADMIN_DECREMENT', 'CONSULT_USED', 'VIP_ENABLED', 'VIP_DISABLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealEstateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "phone" TEXT NOT NULL,
    "responsibleName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RealEstateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCreditWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "availableCredits" INTEGER NOT NULL DEFAULT 3,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCreditWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "CreditLedgerType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalApplication" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "document" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "oragoAnalysisId" TEXT,
    "oragoRawResponse" TEXT,
    "oragoData" TEXT,
    "products" TEXT,
    "rentValue" DECIMAL(65,30) NOT NULL,
    "condominiumValue" DECIMAL(65,30) NOT NULL,
    "feesValue" DECIMAL(65,30) NOT NULL,
    "requestedExpense" DECIMAL(65,30) NOT NULL,
    "automaticDecision" "AutomaticDecisionStatus" NOT NULL,
    "recommendation" "RecommendationStatus" NOT NULL,
    "housingExpenseMin" DECIMAL(65,30),
    "housingExpenseMax" DECIMAL(65,30),
    "decisionReasons" TEXT NOT NULL,
    "decisionMetadata" TEXT,
    "status" "RentalApplicationStatus" NOT NULL DEFAULT 'CONSULTED',
    "tenantName" TEXT,
    "tenantDocument" TEXT,
    "tenantEmail" TEXT,
    "tenantPhone" TEXT,
    "propertyZipCode" TEXT,
    "propertyStreet" TEXT,
    "propertyNumber" TEXT,
    "propertyComplement" TEXT,
    "propertyNeighborhood" TEXT,
    "propertyCity" TEXT,
    "propertyState" TEXT,
    "adminDecision" "AdminDecision",
    "adminDecisionById" TEXT,
    "adminDecisionAt" TIMESTAMP(3),
    "adminDecisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalApplicationContest" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "status" "ContestStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "RentalApplicationContest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING',
    "templateName" TEXT NOT NULL,
    "filePath" TEXT,
    "fileName" TEXT,
    "generatedById" TEXT,
    "errorMessage" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RealEstateProfile_userId_key" ON "RealEstateProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RealEstateProfile_cnpj_key" ON "RealEstateProfile"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "UserCreditWallet_userId_key" ON "UserCreditWallet"("userId");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_idx" ON "CreditLedger"("userId");

-- CreateIndex
CREATE INDEX "CreditLedger_actorId_idx" ON "CreditLedger"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "RentalApplication_oragoAnalysisId_key" ON "RentalApplication"("oragoAnalysisId");

-- CreateIndex
CREATE INDEX "RentalApplication_requesterId_idx" ON "RentalApplication"("requesterId");

-- CreateIndex
CREATE INDEX "RentalApplication_document_idx" ON "RentalApplication"("document");

-- CreateIndex
CREATE INDEX "RentalApplication_status_idx" ON "RentalApplication"("status");

-- CreateIndex
CREATE INDEX "RentalApplication_automaticDecision_idx" ON "RentalApplication"("automaticDecision");

-- CreateIndex
CREATE INDEX "RentalApplicationContest_applicationId_idx" ON "RentalApplicationContest"("applicationId");

-- CreateIndex
CREATE INDEX "RentalApplicationContest_createdById_idx" ON "RentalApplicationContest"("createdById");

-- CreateIndex
CREATE INDEX "RentalApplicationContest_status_idx" ON "RentalApplicationContest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_applicationId_key" ON "Contract"("applicationId");

-- AddForeignKey
ALTER TABLE "RealEstateProfile" ADD CONSTRAINT "RealEstateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreditWallet" ADD CONSTRAINT "UserCreditWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplication" ADD CONSTRAINT "RentalApplication_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplication" ADD CONSTRAINT "RentalApplication_adminDecisionById_fkey" FOREIGN KEY ("adminDecisionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplicationContest" ADD CONSTRAINT "RentalApplicationContest_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RentalApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplicationContest" ADD CONSTRAINT "RentalApplicationContest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplicationContest" ADD CONSTRAINT "RentalApplicationContest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalApplicationContest" ADD CONSTRAINT "RentalApplicationContest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RentalApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
