DO $$
BEGIN
  CREATE TYPE "RealEstateProfileType" AS ENUM ('COMPANY', 'AUTONOMOUS_BROKER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "RealEstateProfile"
ADD COLUMN IF NOT EXISTS "profileType" "RealEstateProfileType" NOT NULL DEFAULT 'COMPANY';

ALTER TABLE "RealEstateProfile"
ADD COLUMN IF NOT EXISTS "documentType" "DocumentType";

ALTER TABLE "RealEstateProfile"
ADD COLUMN IF NOT EXISTS "document" TEXT;

UPDATE "RealEstateProfile"
SET
  "profileType" = 'COMPANY',
  "documentType" = 'CNPJ',
  "document" = REGEXP_REPLACE("cnpj", '\D', '', 'g')
WHERE "document" IS NULL
  AND "cnpj" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "RealEstateProfile_document_key"
ON "RealEstateProfile"("document");