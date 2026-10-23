-- CreateTable
CREATE TABLE IF NOT EXISTS "RealEstateSeller" (
    "id" TEXT NOT NULL,
    "realEstateId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealEstateSeller_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RealEstateSeller_realEstateId_sellerId_key" ON "RealEstateSeller"("realEstateId", "sellerId");
CREATE INDEX IF NOT EXISTS "RealEstateSeller_realEstateId_idx" ON "RealEstateSeller"("realEstateId");
CREATE INDEX IF NOT EXISTS "RealEstateSeller_sellerId_idx" ON "RealEstateSeller"("sellerId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RealEstateSeller_realEstateId_fkey'
  ) THEN
    ALTER TABLE "RealEstateSeller" ADD CONSTRAINT "RealEstateSeller_realEstateId_fkey" FOREIGN KEY ("realEstateId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RealEstateSeller_sellerId_fkey'
  ) THEN
    ALTER TABLE "RealEstateSeller" ADD CONSTRAINT "RealEstateSeller_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Migrate existing seller relationships from User.realEstateId into RealEstateSeller
INSERT INTO "RealEstateSeller" ("id", "realEstateId", "sellerId", "createdAt")
SELECT gen_random_uuid(), "realEstateId", "id", NOW()
FROM "User"
WHERE "role" = 'SELLER' AND "realEstateId" IS NOT NULL
ON CONFLICT ("realEstateId", "sellerId") DO NOTHING;
