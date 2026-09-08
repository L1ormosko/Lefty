-- CreateTable
CREATE TABLE "MediaAssetImageBlob" (
    "imageId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'image/webp',

    CONSTRAINT "MediaAssetImageBlob_pkey" PRIMARY KEY ("imageId")
);

-- AddForeignKey
ALTER TABLE "MediaAssetImageBlob" ADD CONSTRAINT "MediaAssetImageBlob_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAssetImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
