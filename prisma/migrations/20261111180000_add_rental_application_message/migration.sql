-- CreateTable
CREATE TABLE IF NOT EXISTS "RentalApplicationMessage" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "attachmentKey" TEXT,
    "attachmentFileName" TEXT,
    "attachmentMimeType" TEXT,
    "attachmentSizeBytes" INTEGER,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalApplicationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RentalApplicationMessage_applicationId_idx" ON "RentalApplicationMessage"("applicationId");
CREATE INDEX IF NOT EXISTS "RentalApplicationMessage_senderId_idx" ON "RentalApplicationMessage"("senderId");
CREATE INDEX IF NOT EXISTS "RentalApplicationMessage_createdAt_idx" ON "RentalApplicationMessage"("createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RentalApplicationMessage_applicationId_fkey'
    ) THEN
        ALTER TABLE "RentalApplicationMessage" ADD CONSTRAINT "RentalApplicationMessage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RentalApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RentalApplicationMessage_senderId_fkey'
    ) THEN
        ALTER TABLE "RentalApplicationMessage" ADD CONSTRAINT "RentalApplicationMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

