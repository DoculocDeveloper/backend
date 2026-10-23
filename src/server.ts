import { env } from "./config/env.js";
import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";

async function bootstrap() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RealEstateSeller" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "realEstateId" TEXT NOT NULL,
        "sellerId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "RealEstateSeller_realEstateId_sellerId_key" ON "RealEstateSeller"("realEstateId", "sellerId");
      CREATE INDEX IF NOT EXISTS "RealEstateSeller_realEstateId_idx" ON "RealEstateSeller"("realEstateId");
      CREATE INDEX IF NOT EXISTS "RealEstateSeller_sellerId_idx" ON "RealEstateSeller"("sellerId");

      INSERT INTO "RealEstateSeller" ("id", "realEstateId", "sellerId", "createdAt")
      SELECT gen_random_uuid(), "realEstateId", "id", NOW()
      FROM "User"
      WHERE "role" = 'SELLER' AND "realEstateId" IS NOT NULL
      ON CONFLICT ("realEstateId", "sellerId") DO NOTHING;
    `);
    console.log("[DB] RealEstateSeller table ready.");
  } catch (error) {
    console.warn("[DB] Note on RealEstateSeller table check:", error);
  }

  app.listen(env.PORT, env.HOST, () => {
    console.log(`HTTP server running on http://${env.HOST}:${env.PORT}`);
  });
}

bootstrap();