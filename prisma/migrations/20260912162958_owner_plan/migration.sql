-- CreateTable
CREATE TABLE "OwnerPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeListingLimit" INTEGER NOT NULL,
    "paidThrough" TIMESTAMP(3),
    "invoiceRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerPlan_userId_key" ON "OwnerPlan"("userId");

-- AddForeignKey
ALTER TABLE "OwnerPlan" ADD CONSTRAINT "OwnerPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
