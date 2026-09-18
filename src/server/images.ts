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
export async function canViewImage(
  imageId: string,
  viewer: { id: string; role: string } | null
): Promise<boolean> {
  const image = await prisma.mediaAssetImage.findUnique({
    where: { id: imageId },
    select: { asset: { select: { ownerId: true, status: true } } },
  });
  if (!image) return false;

  const { asset } = image;

  if (viewer && (viewer.role === "ADMIN" || viewer.id === asset.ownerId)) return true;
  if (asset.status !== "ACTIVE") return false;

  const access = await viewerAccess(viewer);
  return access.full;
}
