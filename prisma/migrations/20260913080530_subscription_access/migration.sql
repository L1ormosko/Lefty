-- Rename rather than drop-and-create.
--
-- Prisma's generated version dropped "OwnerPlan" and built "Subscription"
-- fresh, which would have destroyed every recorded subscription. The table is
-- probably empty in production - but "probably" is not a basis for deleting a
-- customer's billing record, and a rename costs nothing.

ALTER TABLE "OwnerPlan" RENAME TO "Subscription";
ALTER TABLE "Subscription" RENAME CONSTRAINT "OwnerPlan_pkey" TO "Subscription_pkey";
ALTER TABLE "Subscription" RENAME CONSTRAINT "OwnerPlan_userId_fkey" TO "Subscription_userId_fkey";
ALTER INDEX "OwnerPlan_userId_key" RENAME TO "Subscription_userId_key";

-- Advertisers publish nothing, so the listing cap is no longer required.
ALTER TABLE "Subscription" ALTER COLUMN "activeListingLimit" DROP NOT NULL;

ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "committedUntil" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "monthlyAmount" INTEGER;
