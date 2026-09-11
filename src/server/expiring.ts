import "server-only";

import { prisma } from "./db";
import { addDays, daysBetween, todayUtc } from "@/lib/dates";

/**
 * Contracts that are about to end.
 *
 * This is the one thing VELTO knows that nobody else does. A media owner's
 * renewal window and an advertiser's opening are the same event seen from two
 * sides, and both are derived from APPROVED bookings - not from a field
 * somebody remembered to set, and not from a guess.
 *
 * Note what is NOT here: a prediction that a contract will or will not be
 * renewed. We know the end date. Whether the current advertiser walks away is
 * not something the data says, so the UI reports the date and stops there.
 */

export type ExpiringBooking = {
  bookingId: string;
  assetId: string;
  assetTitle: string;
  city: string;
  endDate: string;
  daysLeft: number;
  advertiserName: string;
};

/** The owner's renewal pipeline: their own assets, sold, ending soon. */
export async function expiringForOwner(ownerId: string, withinDays = 60): Promise<ExpiringBooking[]> {
  const today = todayUtc();
  const rows = await prisma.booking.findMany({
    where: {
      status: "APPROVED",
      asset: { ownerId },
      // Already-ended bookings are the past, not a pipeline.
      endDate: { gte: today, lte: addDays(today, withinDays) },
    },
    orderBy: { endDate: "asc" },
    select: {
      id: true,
      endDate: true,
      assetId: true,
      asset: { select: { title: true, city: true } },
      advertiser: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    bookingId: r.id,
    assetId: r.assetId,
    assetTitle: r.asset.title,
    city: r.asset.city,
    endDate: r.endDate.toISOString().slice(0, 10),
    daysLeft: daysBetween(today, r.endDate) - 1,
    advertiserName: r.advertiser.name,
  }));
}

export type FreeingAsset = {
  assetId: string;
  title: string;
  city: string;
  assetType: string;
  imageUrl: string | null;
  freesOn: string;
  daysLeft: number;
};

/**
 * The advertiser's side: public assets whose current booking ends soon.
 *
 * Only ACTIVE, publicly visible assets, and only the earliest end date per
 * asset - a billboard booked twice in a row frees up when the last one ends,
 * but the first end date is the one worth surfacing, so the list is grouped by
 * asset and keeps the soonest.
 */
export async function freeingSoon(withinDays = 45, limit = 12): Promise<FreeingAsset[]> {
  const today = todayUtc();
  const rows = await prisma.booking.findMany({
    where: {
      status: "APPROVED",
      endDate: { gte: today, lte: addDays(today, withinDays) },
      asset: { status: "ACTIVE" },
    },
    orderBy: { endDate: "asc" },
    select: {
      endDate: true,
      assetId: true,
      asset: {
        select: {
          title: true,
          city: true,
          assetType: true,
          images: { where: { isPrimary: true }, take: 1, select: { url: true } },
        },
      },
    },
  });

  const seen = new Map<string, FreeingAsset>();
  for (const r of rows) {
    if (seen.has(r.assetId)) continue;
    seen.set(r.assetId, {
      assetId: r.assetId,
      title: r.asset.title,
      city: r.asset.city,
      assetType: r.asset.assetType,
      imageUrl: r.asset.images[0]?.url ?? null,
      freesOn: r.endDate.toISOString().slice(0, 10),
      daysLeft: daysBetween(today, r.endDate) - 1,
    });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}
