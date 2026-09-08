import "server-only";

import { prisma } from "@/server/db";

/**
 * Where uploaded image bytes live.
 *
 * They used to be written to `public/uploads` on local disk. That is fine on a
 * laptop and silently destructive on the host we deploy to: the filesystem is
 * ephemeral, so every deploy wiped every photo an owner had ever uploaded,
 * leaving MediaAssetImage rows pointing at 404s. Publishing an asset requires a
 * photo, so listings passed validation and then quietly broke.
 *
 * The bytes now live in Postgres, which is the store we already back up and
 * already treat as the source of truth. This is a deliberate trade, not a
 * default: a WebP at 1920px/q82 runs 150-400KB, so a fully photographed asset
 * is around 3MB and a 1GB database holds on the order of 250 of them. That is
 * comfortable for the Be'er Sheva pilot and is not a national-scale answer.
 *
 * Everything storage-specific is in this file. Moving to object storage (R2,
 * S3) means reimplementing these two functions and backfilling; no caller
 * changes, because callers only ever see the opaque `url` string.
 */

/** Encoded output above this is refused: the ceiling here is the database. */
export const MAX_STORED_BYTES = 2 * 1024 * 1024;

export type StoredImage = { data: Buffer; contentType: string };

/**
 * The public path an image is served from. Callers persist this on
 * MediaAssetImage.url and otherwise treat it as opaque.
 */
export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}`;
}

/**
 * Write the bytes for an image row that already exists.
 *
 * Callers should do this inside the same transaction that creates the row -
 * an image row without bytes renders as a broken picture, which is precisely
 * the failure this module exists to end.
 */
export async function storeImage(params: {
  imageId: string;
  data: Buffer;
  contentType?: string;
  tx?: Pick<typeof prisma, "mediaAssetImageBlob">;
}): Promise<void> {
  const client = params.tx ?? prisma;
  await client.mediaAssetImageBlob.create({
    data: {
      imageId: params.imageId,
      // Prisma's Bytes maps to Uint8Array<ArrayBuffer>; a Node Buffer can sit
      // on a SharedArrayBuffer, so hand it a plain view rather than casting.
      data: new Uint8Array(params.data),
      contentType: params.contentType ?? "image/webp",
    },
  });
}

export async function readImage(imageId: string): Promise<StoredImage | null> {
  const blob = await prisma.mediaAssetImageBlob.findUnique({
    where: { imageId },
    select: { data: true, contentType: true },
  });
  if (!blob) return null;
  return { data: Buffer.from(blob.data), contentType: blob.contentType };
}

/**
 * There is deliberately no deleteImage(). MediaAssetImageBlob cascades from
 * MediaAssetImage, so deleting an image disposes of its bytes in the same
 * statement. The disk implementation needed a companion unlink, and the one
 * place that deleted an image forgot it - every deleted photo leaked a file
 * that nothing would ever reclaim. Making that unrepresentable is the point.
 */
