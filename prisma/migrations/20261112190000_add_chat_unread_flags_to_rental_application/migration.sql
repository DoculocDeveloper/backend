-- AlterTable
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "hasUnreadStaffMessages" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "hasUnreadClientMessages" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RentalApplication_hasUnreadStaffMessages_idx" ON "RentalApplication"("hasUnreadStaffMessages");
CREATE INDEX IF NOT EXISTS "RentalApplication_hasUnreadClientMessages_idx" ON "RentalApplication"("hasUnreadClientMessages");

-- Atualiza dados existentes com base em mensagens nao lidas atuais
UPDATE "RentalApplication" a
SET "hasUnreadStaffMessages" = true
WHERE EXISTS (
  SELECT 1 FROM "RentalApplicationMessage" m
  WHERE m."applicationId" = a.id AND m."isStaff" = false AND m."readAt" IS NULL
);

UPDATE "RentalApplication" a
SET "hasUnreadClientMessages" = true
WHERE EXISTS (
  SELECT 1 FROM "RentalApplicationMessage" m
  WHERE m."applicationId" = a.id AND m."isStaff" = true AND m."readAt" IS NULL
);

-- Rollback SQL (comentado):
-- DROP INDEX IF EXISTS "RentalApplication_hasUnreadStaffMessages_idx";
-- DROP INDEX IF EXISTS "RentalApplication_hasUnreadClientMessages_idx";
-- ALTER TABLE "RentalApplication" DROP COLUMN IF EXISTS "hasUnreadStaffMessages";
-- ALTER TABLE "RentalApplication" DROP COLUMN IF EXISTS "hasUnreadClientMessages";
-- ALTER TABLE "RentalApplication" DROP COLUMN IF EXISTS "lastMessageAt";

