import "server-only";

import type { PutInput, StorageProvider, StoredImage } from "./provider";

/**
 * A photograph VELTO does not hold.
 *
 * Every other provider in this directory owns bytes. This one owns a
 * description: a panorama id, a heading, a field of view - and fetches the
 * frame from Google each time it is asked for. That is deliberate and it is
 * the whole reason this file is a storage provider rather than a special case
 * threaded through the image code.
 *
 * Two things fall out of it, and both are the point:
 *
 * 1. **Nothing of Google's is stored.** Their terms put hard limits on
 *    caching their imagery. A description of a view is not their imagery, and
 *    a row carrying one can live in our database indefinitely without holding
 *    anything of theirs. The bytes exist for the length of one request.
 *
 * 2. **Every caller already works.** The authorization check in
 *    server/images.ts, the /api/images/[id] route, the surface quad, the
 *    detection, the turntable ordering - none of them learn that this photo
 *    is not ours, because readImageAt() resolves the provider per row and has
 *    always been allowed to.
 *
 * What a listing gets from this: a creative preview even when the owner
 * uploaded no photograph at all, which until now meant no preview existed.
 * The screen says where the picture came from - see the mockup panel - because
 * a Street View frame from 2019 is a different kind of evidence from a photo
 * the owner took last week, and the advertiser is entitled to know which one
 * they are looking at.
 */

/** The key is the view: `streetview/<panoId>/<heading>/<fov>/<pitch>`. */
export function streetViewKeyFor(view: {
  panoId: string;
  heading: number;
  fov: number;
  pitch?: number;
}): string {
  return `streetview/${view.panoId}/${Math.round(view.heading)}/${Math.round(view.fov)}/${Math.round(view.pitch ?? 10)}`;
}

/**
 * The one place a key of this kind is parsed.
 *
 * A key is opaque to callers - rule 1 of the provider contract - but not to
 * the provider that minted it, which is the only thing that can read it.
 */
function parseKey(key: string): { panoId: string; heading: number; fov: number; pitch: number } | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "streetview") return null;
  const [, panoId, heading, fov, pitch] = parts;
  const nums = [heading, fov, pitch].map(Number);
  if (!panoId || nums.some((n) => !Number.isFinite(n))) return null;
  return { panoId, heading: nums[0], fov: nums[1], pitch: nums[2] };
}

const STATIC_URL = "https://maps.googleapis.com/maps/api/streetview";
const TIMEOUT_MS = 10_000;
/** Big enough to mark a face on, small enough not to be a page weight problem. */
const SIZE = "640x400";

export const streetViewStorage: StorageProvider = {
  name: "streetview",

  /**
   * There is nothing to write.
   *
   * Refused rather than quietly ignored: a caller trying to store bytes here
   * has misunderstood what this row is, and failing at the call site is how
   * they find that out now instead of when the image comes back empty.
   */
  async put(_input: PutInput): Promise<void> {
    throw new Error(
      "streetview storage holds no bytes - a Street View row describes a view, it does not store one"
    );
  },

  async get(key: string): Promise<StoredImage | null> {
    const view = parseKey(key);
    if (!view) return null;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY?.trim();
    if (!apiKey) return null;

    const url =
      `${STATIC_URL}?size=${SIZE}&pano=${encodeURIComponent(view.panoId)}` +
      `&heading=${view.heading}&fov=${view.fov}&pitch=${view.pitch}` +
      `&key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      // The Static API answers 200 with a grey "no imagery" tile for a
      // panorama it cannot serve, so the status alone is not proof. The
      // content type is: an error comes back as text.
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) {
        console.error("[velto] Street View image failed:", res.status, type);
        return null;
      }
      const data = Buffer.from(await res.arrayBuffer());
      return { data, contentType: type.split(";")[0] };
    } catch (err) {
      console.error("[velto] Street View image threw:", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /** Nothing of ours to remove. Deleting the row is the whole deletion. */
  async remove(): Promise<void> {},
};
