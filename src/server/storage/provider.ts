import "server-only";

/**
 * Where image bytes live - as a contract, not as a place.
 *
 * The rest of the application never learns which store is behind this. It
 * hands over bytes and gets back a key and a URL; it asks for a key and gets
 * back bytes. Swapping Postgres for R2, S3 or Supabase Storage is then a new
 * file in this directory and one line in index.ts, with no caller to change
 * and no schema migration beyond a backfill of `storageKey`.
 *
 * Four rules the implementations are held to:
 *
 *   1. **A key is opaque.** Callers persist it on MediaAssetImage.storageKey
 *      and never parse it. One store's key is a row id, another's is an object
 *      path; anything that inspects the string couples the app to one of them.
 *
 *   2. **`put` is the last thing that can fail.** The image row is written
 *      first so the bytes have something to belong to, and the whole thing is
 *      wrapped so a failed write leaves neither a row without bytes nor bytes
 *      without a row - a half-written image renders as a broken picture, which
 *      is exactly the failure this module was built to end.
 *
 *   3. **`url` is served by us, never by the store.** Even once the bytes sit
 *      in object storage, the browser asks /api/images/[id], because that is
 *      where the authorization check lives (server/images.ts). A public bucket
 *      URL would hand every photograph to anyone who guessed a path, which is
 *      the hole this release closed. When a provider supports signed URLs,
 *      that route can redirect to a short-lived one - the decision stays here.
 *
 *   4. **`remove` is optional and best-effort.** MediaAssetImageBlob cascades
 *      from MediaAssetImage, so the database provider needs no deletion path
 *      at all; an object store does, and an orphaned object is a cost problem
 *      rather than a correctness one.
 */

export type StoredImage = { data: Buffer; contentType: string };

/**
 * A transaction handle, passed through opaquely.
 *
 * Only a provider that stores bytes in the same database as the rows can use
 * it, and the database provider does - that is how an image row and its bytes
 * are written atomically today. Every other provider ignores it: an HTTP PUT
 * to a bucket is not in anyone's transaction, and pretending otherwise is how
 * you end up with a rolled-back row pointing at a real object.
 */
export type StorageTransaction = unknown;

export type PutInput = {
  /** Caller-chosen key. Must be stable and unique; see imageKey(). */
  key: string;
  data: Buffer;
  contentType: string;
  tx?: StorageTransaction;
};

export interface StorageProvider {
  /** Stable identifier, recorded on the row so a half-migrated set still serves. */
  readonly name: string;
  put(input: PutInput): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  remove?(key: string): Promise<void>;
}

/**
 * The key for one image.
 *
 * Includes the asset so that an object store lists usefully and a whole
 * listing's photographs can be removed with one prefix delete. The database
 * provider ignores the shape entirely and looks the row up by image id, which
 * is why the id has to be the last segment.
 */
export function imageKey(assetId: string, imageId: string): string {
  return `assets/${assetId}/${imageId}.webp`;
}

/** The image id back out of a key. The one place a key is ever parsed. */
export function imageIdFromKey(key: string): string {
  const last = key.split("/").pop() ?? key;
  return last.replace(/\.[a-z0-9]+$/i, "");
}
