-- AlterEnum
ALTER TYPE "RentalApplicationStatus" ADD VALUE IF NOT EXISTS 'WAITING_REAL_ESTATE_RETURN';

-- AlterTable
ALTER TABLE "RentalApplication" ADD COLUMN IF NOT EXISTS "previousStatus" "RentalApplicationStatus";

-- Rollback SQL (comentado):
-- ALTER TABLE "RentalApplication" DROP COLUMN IF EXISTS "previousStatus";
-- Observacao PostgreSQL: valores de enum adicionados com ALTER TYPE nao podem ser removidos individualmente sem recriacao do tipo.

