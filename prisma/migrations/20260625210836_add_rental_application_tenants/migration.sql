-- CreateTable
CREATE TABLE "RentalApplicationTenant" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalApplicationTenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentalApplicationTenant_applicationId_idx" ON "RentalApplicationTenant"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "RentalApplicationTenant_applicationId_order_key" ON "RentalApplicationTenant"("applicationId", "order");

-- AddForeignKey
ALTER TABLE "RentalApplicationTenant" ADD CONSTRAINT "RentalApplicationTenant_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RentalApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
