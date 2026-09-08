/**
 * Public inventory queries.
 *
 * Only ACTIVE assets are ever public. Demo/seed assets stay visible (the
 * database is a development database) but carry isDemo so the UI can label
 * them - they are never presented as verified commercial inventory.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { MapQuery } from "@/lib/validation";
import { availabilityFor, estimatePrice, nextAvailableDate } from "@/lib/availability";
import type { AvailabilityState } from "@/lib/constants";
import { daysBetween, toUtcDate, todayUtc } from "@/lib/dates";

export type MapAsset = {
  id: string;
  title: string;
  city: string;
  address: string;
  assetType: string;
  isDigital: boolean;
  latitude: number;
  longitude: number;
  priceMonthly: number | null;
  priceWeekly: number | null;
  verificationStatus: string;
  isDemo: boolean;
  imageUrl: string | null;
  availability: AvailabilityState;
  nextAvailable: string | null;
};

function buildWhere(q: MapQuery): Prisma.MediaAssetWhereInput {
  const where: Prisma.MediaAssetWhereInput = { status: "ACTIVE" };

  if (q.minLat != null && q.maxLat != null) {
    where.latitude = { gte: q.minLat, lte: q.maxLat };
  }
  if (q.minLng != null && q.maxLng != null) {
    where.longitude = { gte: q.minLng, lte: q.maxLng };
  }
  if (q.city) where.city = { equals: q.city, mode: "insensitive" };
  if (q.q) {
    where.OR = [
      { title: { contains: q.q, mode: "insensitive" } },
      { address: { contains: q.q, mode: "insensitive" } },
      { city: { contains: q.q, mode: "insensitive" } },
    ];
  }
  const types = q.types?.split(",").filter(Boolean);
  if (types?.length) where.assetType = { in: types as never[] };
  if (q.digitalOnly === "1") where.isDigital = true;
  if (q.verifiedOnly === "1") where.verificationStatus = "VERIFIED";

  // Price filters apply to published monthly prices only. Assets without a
  // published price are kept unless the advertiser set a maximum, because an
  // unpriced asset cannot be claimed to be within a budget.
  if (q.minPrice != null || q.maxPrice != null) {
    const price: Prisma.IntNullableFilter = {};
    if (q.minPrice != null) price.gte = q.minPrice;
    if (q.maxPrice != null) price.lte = q.maxPrice;
    where.priceMonthly = price;
  }

  return where;
}

export async function queryMapAssets(q: MapQuery): Promise<MapAsset[]> {
  const window =
    q.startDate && q.endDate
      ? { start: toUtcDate(q.startDate), end: toUtcDate(q.endDate) }
      : undefined;

  const rows = await prisma.mediaAsset.findMany({
    where: buildWhere(q),
    take: q.limit,
    orderBy: [{ verificationStatus: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      city: true,
      address: true,
      assetType: true,
      isDigital: true,
      latitude: true,
      longitude: true,
      priceMonthly: true,
      priceWeekly: true,
      status: true,
      verificationStatus: true,
      isDemo: true,
      images: {
        where: { isPrimary: true },
        take: 1,
        select: { url: true },
      },
      periods: { select: { startDate: true, endDate: true } },
      bookings: {
        where: { status: "APPROVED" },
        select: { startDate: true, endDate: true },
      },
    },
  });

  const today = todayUtc();
  const wanted = q.availability?.split(",").filter(Boolean) as AvailabilityState[] | undefined;

  const mapped = rows.map((r) => {
    const availability = availabilityFor(
      {
        status: r.status,
        verificationStatus: r.verificationStatus,
        periods: r.periods,
        approvedBookings: r.bookings,
      },
      window
    );
    const next = nextAvailableDate(
      {
        status: r.status,
        verificationStatus: r.verificationStatus,
        periods: r.periods,
        approvedBookings: r.bookings,
      },
      window?.start ?? today
    );
    return {
      id: r.id,
      title: r.title,
      city: r.city,
      address: r.address,
      assetType: r.assetType,
      isDigital: r.isDigital,
      latitude: r.latitude,
      longitude: r.longitude,
      priceMonthly: r.priceMonthly,
      priceWeekly: r.priceWeekly,
      verificationStatus: r.verificationStatus,
      isDemo: r.isDemo,
      imageUrl: r.images[0]?.url ?? null,
      availability,
      nextAvailable: next ? next.toISOString().slice(0, 10) : null,
    } satisfies MapAsset;
  });

  return wanted?.length ? mapped.filter((a) => wanted.includes(a.availability)) : mapped;
}

/**
 * Full public detail for one asset. Returns null when it must not be public.
 *
 * Only ACTIVE assets are public. A draft, a deactivated asset, or one an admin
 * rejected stays reachable to its own owner and to admins (so they can review
 * what the public would have seen) and to nobody else - a taken-down listing
 * must stop exposing its contact details to anyone holding the URL.
 */
export async function getPublicAsset(id: string, viewer?: { id: string; role: string } | null) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id },
    include: {
      images: { orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }] },
      periods: { orderBy: { startDate: "asc" } },
      bookings: { where: { status: "APPROVED" }, select: { startDate: true, endDate: true } },
      // Company-level contact only. Personal phone/email of the owner user is
      // never exposed publicly.
      company: { select: { id: true, name: true, contactEmail: true, contactPhone: true, website: true } },
      owner: { select: { id: true, name: true } },
    },
  });
  if (!asset) return null;
  if (asset.status !== "ACTIVE") {
    const privileged = viewer && (viewer.role === "ADMIN" || viewer.id === asset.ownerId);
    if (!privileged) return null;
  }
  return asset;
}

export type PublicAsset = NonNullable<Awaited<ReturnType<typeof getPublicAsset>>>;

export function assetAvailability(asset: PublicAsset, window?: { start: Date; end: Date }) {
  return availabilityFor(
    {
      status: asset.status,
      verificationStatus: asset.verificationStatus,
      periods: asset.periods,
      approvedBookings: asset.bookings,
    },
    window
  );
}

export function assetPriceEstimate(asset: PublicAsset, start: Date, end: Date) {
  return estimatePrice(asset, daysBetween(start, end));
}

/** Distinct cities that actually have public inventory - never a hardcoded list. */
export async function citiesWithInventory(): Promise<{ city: string; count: number }[]> {
  const rows = await prisma.mediaAsset.groupBy({
    by: ["city"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });
  return rows.map((r) => ({ city: r.city, count: r._count._all }));
}

/**
 * Real, non-demo public inventory, for the marketing page.
 *
 * Deliberately excludes `isDemo` rows: a city count that includes seed data
 * reads to a visitor as a claim about commercial inventory we do not have.
 * When this comes back empty the landing page says so plainly rather than
 * dressing up demo rows as a marketplace - see DECISIONS.md.
 */
export async function realInventorySummary(): Promise<{
  assets: number;
  cities: { city: string; count: number }[];
}> {
  const rows = await prisma.mediaAsset.groupBy({
    by: ["city"],
    where: { status: "ACTIVE", isDemo: false },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });
  return {
    assets: rows.reduce((sum, r) => sum + r._count._all, 0),
    cities: rows.map((r) => ({ city: r.city, count: r._count._all })),
  };
}
