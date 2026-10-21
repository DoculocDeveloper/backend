-- AlterTable
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "adminViewedAt" TIMESTAMP(3);

-- Marcar consultas já existentes no banco como lidas para não gerar notificações falsas de dados legados
UPDATE "RentalApplication"
SET "adminViewedAt" = NOW()
WHERE "adminViewedAt" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RentalApplication_adminViewedAt_idx" ON "RentalApplication"("adminViewedAt");
