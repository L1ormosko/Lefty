-- Storage metadata on the image row, so the bytes can move to an object store
-- without the rest of the application knowing. Additive and nullable: existing
-- rows are backfilled below with the identity the database provider already
-- uses, which is the image id itself.
ALTER TABLE "MediaAssetImage" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "MediaAssetImage" ADD COLUMN "storageProvider" TEXT;

UPDATE "MediaAssetImage" i
SET "storageKey" = i."id",
    "storageProvider" = 'database'
FROM "MediaAssetImageBlob" b
WHERE b."imageId" = i."id" AND i."storageKey" IS NULL;
