import "server-only";

import { prisma } from "@/server/db";
import { imageIdFromKey, type PutInput, type StorageProvider, type StoredImage } from "./provider";

/**
 * Image bytes in Postgres.
 *
 * This is the provider VELTO runs on today, and it is explicitly a stopgap.
 * The history matters, because it is why the obvious alternative is worse
 * rather than better: the bytes used to be written to `public/uploads` on
 * local disk, which is fine on a laptop and silently destructive on an
 * ephemeral host - every deploy wiped every photograph an owner had uploaded
 * and left MediaAssetImage rows pointing at 404s. Publishing an asset requires
 * a photo, so listings passed validation and then quietly broke.
 *
 * Postgres at least survives a deploy and is already backed up. What it is not
 * is a national-scale answer: a WebP at 1920px/q82 runs 150-400KB, a fully
 * photographed asset is around 3MB, and a 1GB database therefore holds on the
 * order of 250 of them. **That ceiling arrives without warning.**
 *
 * The replacement is an object store, and the work to switch is now: write a
 * sibling of this file, add it to the map in index.ts, set VELTO_STORAGE, and
 * backfill. Nothing outside this directory changes.
 */
export const databaseStorage: StorageProvider = {
  name: "database",

  async put({ key, data, contentType, tx }: PutInput): Promise<void> {
    // The blob table is keyed by image id, so the key is unwrapped here and
    // nowhere else - see the "a key is opaque" rule in provider.ts.
    const imageId = imageIdFromKey(key);
    const client = (tx as typeof prisma | undefined) ?? prisma;
    await client.mediaAssetImageBlob.create({
      data: {
        imageId,
        // Prisma's Bytes maps to Uint8Array<ArrayBuffer>; a Node Buffer can sit
        // on a SharedArrayBuffer, so hand it a plain view rather than casting.
        data: new Uint8Array(data),
        contentType,
      },
    });
  },

  async get(key: string): Promise<StoredImage | null> {
    const blob = await prisma.mediaAssetImageBlob.findUnique({
      where: { imageId: imageIdFromKey(key) },
      select: { data: true, contentType: true },
    });
    if (!blob) return null;
    return { data: Buffer.from(blob.data), contentType: blob.contentType };
  },

  // No remove(): MediaAssetImageBlob cascades from MediaAssetImage, so
  // deleting an image disposes of its bytes in the same statement. The disk
  // implementation needed a companion unlink and the one place that deleted an
  // image forgot it - every deleted photo leaked a file nothing would reclaim.
  // Making that unrepresentable is the point.
};
