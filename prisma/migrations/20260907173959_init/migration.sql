-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADVERTISER', 'MEDIA_OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('ADVERTISER', 'MEDIA_OWNER');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('BILLBOARD', 'DIGITAL_BILLBOARD', 'WALL', 'TOTEM', 'BUS_STOP', 'STREET_FURNITURE', 'BANNER', 'OTHER');

-- CreateEnum
CREATE TYPE "Illumination" AS ENUM ('NONE', 'FRONTLIT', 'BACKLIT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PermitStatus" AS ENUM ('UNKNOWN', 'PERMITTED', 'NOT_PERMITTED');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('PENDING', 'RESPONDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InquiryIntent" AS ENUM ('AVAILABILITY', 'QUOTE', 'BOOKING');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INQUIRY_CREATED', 'INQUIRY_RESPONDED', 'BOOKING_REQUESTED', 'BOOKING_APPROVED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'ASSET_VERIFIED', 'ASSET_REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ADVERTISER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CompanyType" NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "website" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assetType" "AssetType" NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "widthCm" INTEGER,
    "heightCm" INTEGER,
    "orientation" TEXT,
    "sides" INTEGER NOT NULL DEFAULT 1,
    "illumination" "Illumination" NOT NULL DEFAULT 'UNKNOWN',
    "isDigital" BOOLEAN NOT NULL DEFAULT false,
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFT',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "permitStatus" "PermitStatus" NOT NULL DEFAULT 'UNKNOWN',
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "reviewNote" TEXT,
    "priceWeekly" INTEGER,
    "priceMonthly" INTEGER,
    "minimumBookingDays" INTEGER NOT NULL DEFAULT 7,
    "productionIncluded" BOOLEAN NOT NULL DEFAULT false,
    "installationIncluded" BOOLEAN NOT NULL DEFAULT false,
    "removalIncluded" BOOLEAN NOT NULL DEFAULT false,
    "instantBookable" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAssetImage" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAssetImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityPeriod" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "intent" "InquiryIntent" NOT NULL DEFAULT 'AVAILABILITY',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "campaignName" TEXT NOT NULL,
    "budget" INTEGER,
    "message" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "status" "InquiryStatus" NOT NULL DEFAULT 'PENDING',
    "ownerResponse" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "inquiryId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "priceEstimate" INTEGER,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "ownerNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_idx" ON "MediaAsset"("ownerId");

-- CreateIndex
CREATE INDEX "MediaAsset_status_verificationStatus_idx" ON "MediaAsset"("status", "verificationStatus");

-- CreateIndex
CREATE INDEX "MediaAsset_city_idx" ON "MediaAsset"("city");

-- CreateIndex
CREATE INDEX "MediaAsset_assetType_idx" ON "MediaAsset"("assetType");

-- CreateIndex
CREATE INDEX "MediaAsset_status_latitude_longitude_idx" ON "MediaAsset"("status", "latitude", "longitude");

-- CreateIndex
CREATE INDEX "MediaAssetImage_assetId_sortOrder_idx" ON "MediaAssetImage"("assetId", "sortOrder");

-- CreateIndex
CREATE INDEX "AvailabilityPeriod_assetId_startDate_endDate_idx" ON "AvailabilityPeriod"("assetId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Inquiry_assetId_status_idx" ON "Inquiry"("assetId", "status");

-- CreateIndex
CREATE INDEX "Inquiry_advertiserId_createdAt_idx" ON "Inquiry"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_assetId_status_startDate_endDate_idx" ON "Booking"("assetId", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_advertiserId_createdAt_idx" ON "Booking"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "SavedAsset_userId_createdAt_idx" ON "SavedAsset"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedAsset_userId_assetId_key" ON "SavedAsset"("userId", "assetId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAssetImage" ADD CONSTRAINT "MediaAssetImage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityPeriod" ADD CONSTRAINT "AvailabilityPeriod_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAsset" ADD CONSTRAINT "SavedAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAsset" ADD CONSTRAINT "SavedAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data-integrity constraints that Prisma schema cannot express.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Coordinates must be real coordinates.
ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "MediaAsset_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "MediaAsset_sides_positive" CHECK ("sides" > 0),
  ADD CONSTRAINT "MediaAsset_min_days_positive" CHECK ("minimumBookingDays" > 0),
  ADD CONSTRAINT "MediaAsset_price_weekly_nonneg" CHECK ("priceWeekly" IS NULL OR "priceWeekly" >= 0),
  ADD CONSTRAINT "MediaAsset_price_monthly_nonneg" CHECK ("priceMonthly" IS NULL OR "priceMonthly" >= 0);

-- Date ranges are inclusive [start, end] and must not be inverted.
ALTER TABLE "AvailabilityPeriod"
  ADD CONSTRAINT "AvailabilityPeriod_date_order" CHECK ("startDate" <= "endDate");
ALTER TABLE "Inquiry"
  ADD CONSTRAINT "Inquiry_date_order" CHECK ("startDate" <= "endDate");
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_date_order" CHECK ("startDate" <= "endDate");

-- The double-booking guarantee. Enforced by the database, so no application
-- code path (including a future background job or a second app instance) can
-- create two approved bookings that overlap on the same asset.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlapping_approved"
  EXCLUDE USING gist (
    "assetId" WITH =,
    daterange("startDate", "endDate", '[]') WITH &&
  ) WHERE (status = 'APPROVED');
