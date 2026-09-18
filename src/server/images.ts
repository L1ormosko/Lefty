import "server-only";

import { prisma } from "./db";
import { viewerAccess } from "./subscription";

/**
 * Who may look at the photograph of a listing.
 *
 * One function, because the question has to be answered identically wherever
 * an image is reachable, and the failure mode of getting it wrong twice is a
 * private photograph served to the internet.
 *
 * The rules, in the order they are checked:
 *
 *   1. The owner of the listing, and any admin, always may. An admin who
 *      cannot see the photo cannot verify the listing.
 *   2. Nobody else may see an image of a listing that is not ACTIVE. A draft
 *      the owner never published, a listing they took down, and one an admin
 *      rejected are all private - taking a listing off the map has to take its
 *      photographs with it.
 *   3. For an ACTIVE listing, the photograph is part of what the subscription
 *      buys, the same as the address and the price. A viewer without access
 *      gets the listing with `imageUrl: null`, so a request for the bytes is
 *      either a stale URL or someone trying the id directly; either way the
 *      answer is no.
 *
 * Note what this deliberately does NOT do: it does not try to be clever about
 * which images are "public enough". Every image belongs to exactly one asset,
 * and the asset's own visibility decides.
 */

/** What the route needs to find the bytes, once it is allowed to. */
export type ViewableImage = {
  id: string;
  assetId: string;
  storageKey: string | null;
  storageProvider: string | null;
};

/**
 * The permission check and the lookup, in one query.
 *
 * They were two: `canViewImage` read the image to find its asset, then
 * `readImage` read the same row again to find its storage key. Measuring the
 * map showed the cost - roughly seven queries per image request, once per card
 * on screen - so the row is read once and handed on.
 *
 * Returns null when the image does not exist *or* when it may not be seen.
 * Collapsing the two is deliberate: the route answers 404 either way, because
 * whether an image exists is itself information about a listing that is not
 * public.
 */
export async function loadViewableImage(
  imageId: string,
  viewer: { id: string; role: string } | null
): Promise<ViewableImage | null> {
  const image = await prisma.mediaAssetImage.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      assetId: true,
      storageKey: true,
      storageProvider: true,
      asset: { select: { ownerId: true, status: true } },
    },
  });
  if (!image) return null;

  const { asset, ...rest } = image;

  // The owner and admins never need the subscription lookup - which is the
  // whole reason this order is worth keeping.
  if (viewer && (viewer.role === "ADMIN" || viewer.id === asset.ownerId)) return rest;
  if (asset.status !== "ACTIVE") return null;

  // An anonymous viewer costs nothing here: viewerAccess(null) answers without
  // touching the database.
  const access = await viewerAccess(viewer);
  return access.full ? rest : null;
}

/**
 * The same decision as a boolean.
 *
 * Kept as its own export because it is what the tests assert on, and because
 * "may this person see this image" reads better at a call site than "did the
 * lookup return a row".
 */
export async function canViewImage(
  imageId: string,
  viewer: { id: string; role: string } | null
): Promise<boolean> {
  return (await loadViewableImage(imageId, viewer)) != null;
}
