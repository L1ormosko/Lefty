import "server-only";

import { prisma } from "@/server/db";
import { databaseStorage } from "./database";
import { imageKey, type StorageProvider, type StoredImage } from "./provider";

export { imageKey, imageIdFromKey } from "./provider";
export type { StorageProvider, StoredImage, PutInput } from "./provider";

/**
 * The storage the application actually uses.
 *
 * One map and one environment variable. Adding S3/R2/Supabase means writing a
 * sibling of database.ts and adding it here - no caller changes, because no
 * caller has ever seen a provider.
 */
const PROVIDERS: Record<string, StorageProvider> = {
  database: databaseStorage,
};

function selectProvider(): StorageProvider {
  const name = process.env.VELTO_STORAGE?.trim();
  if (!name) return databaseStorage;
  const provider = PROVIDERS[name];
  if (!provider) {
    // Loud, and then the safe default. A typo in an environment variable must
    // not take image serving down, and must not be silent either.
    console.error(
      `[velto] VELTO_STORAGE="${name}" is not a known provider ` +
        `(have: ${Object.keys(PROVIDERS).join(", ")}). Falling back to "database".`
    );
    return databaseStorage;
  }
  return provider;
}

export const storage: StorageProvider = selectProvider();

/**
 * Encoded output above this is refused.
 *
 * The number is a property of the current provider - it is the database that
 * cannot take large rows comfortably - so it moves with the provider rather
 * than being a fact about images.
 */
export const MAX_STORED_BYTES = storage.name === "database" ? 2 * 1024 * 1024 : 10 * 1024 * 1024;

/**
 * The path an image is served from.
 *
 * Always our own route, whatever the provider: that is where the authorization
 * check lives (server/images.ts). Handing out a bucket URL would make every
 * photograph public to anyone holding the link.
 */
export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}`;
}

/**
 * Store the bytes for an image row that already exists.
 *
 * Returns what the row should record about them. The caller writes the row and
 * this in the same transaction where the provider supports it; where it does
 * not, the caller removes the row if this throws.
 */
export async function storeImage(params: {
  assetId: string;
  imageId: string;
  data: Buffer;
  contentType?: string;
  tx?: unknown;
}): Promise<{ storageKey: string; storageProvider: string }> {
  const key = imageKey(params.assetId, params.imageId);
  await storage.put({
    key,
    data: params.data,
    contentType: params.contentType ?? "image/webp",
    tx: params.tx,
  });
  return { storageKey: key, storageProvider: storage.name };
}

/** The parts of an image row that say where its bytes are. */
export type ImageLocation = {
  id: string;
  assetId: string;
  storageKey: string | null;
  storageProvider: string | null;
};

/**
 * Read an image's bytes from a row that has already been loaded.
 *
 * The caller has the row because it had to read it to answer "may this person
 * see this?" (server/images.ts). Re-reading it here was a second query on
 * every single image request, which on a map of sixteen cards is sixteen
 * avoidable round trips.
 *
 * Resolves the provider *per row*, so a database half-migrated between stores
 * still serves every image: each row says where its own bytes live.
 */
export async function readImageAt(row: ImageLocation): Promise<StoredImage | null> {
  const provider = row.storageProvider ? PROVIDERS[row.storageProvider] : undefined;
  // Rows written before this abstraction have neither field. They are all in
  // the database provider by definition - it was the only one - so that is the
  // honest fallback rather than a failure.
  const from = provider ?? databaseStorage;
  const key = row.storageKey ?? imageKey(row.assetId, row.id);
  return from.get(key);
}

/**
 * Read an image's bytes by id, looking the row up first.
 *
 * For callers that do not already hold the row - tests, and any future
 * maintenance script. The serving path uses readImageAt().
 */
export async function readImage(imageId: string): Promise<StoredImage | null> {
  const row = await prisma.mediaAssetImage.findUnique({
    where: { id: imageId },
    select: { id: true, storageKey: true, storageProvider: true, assetId: true },
  });
  return row ? readImageAt(row) : null;
}
