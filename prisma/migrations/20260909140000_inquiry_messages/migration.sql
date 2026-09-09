-- Inquiries become conversations.
--
-- Order matters here: the table is created and the existing single response is
-- copied into it BEFORE the column is dropped. Prisma's generated diff put the
-- DROP first, which would have silently thrown away every reply a media owner
-- had ever written.

-- CreateTable
CREATE TABLE "InquiryMessage" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquiryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InquiryMessage_inquiryId_createdAt_idx" ON "InquiryMessage"("inquiryId", "createdAt");

-- AddForeignKey
ALTER TABLE "InquiryMessage" ADD CONSTRAINT "InquiryMessage_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryMessage" ADD CONSTRAINT "InquiryMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing owner response becomes the first message in its
-- thread, authored by the asset's owner and timed when it was actually sent.
INSERT INTO "InquiryMessage" ("id", "inquiryId", "authorId", "body", "createdAt")
SELECT
    gen_random_uuid()::text,
    i."id",
    a."ownerId",
    i."ownerResponse",
    COALESCE(i."respondedAt", i."updatedAt")
FROM "Inquiry" i
JOIN "MediaAsset" a ON a."id" = i."assetId"
WHERE i."ownerResponse" IS NOT NULL
  AND btrim(i."ownerResponse") <> '';

-- Only now is it safe: the text lives in InquiryMessage.
ALTER TABLE "Inquiry" DROP COLUMN "ownerResponse";
