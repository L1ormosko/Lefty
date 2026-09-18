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
import { coarse } from "@/lib/subscription";
import { t } from "@/lib/labels";

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
  /**
   * True when this row has been blurred for a viewer without access.
   *
   * The card reads this to label itself honestly rather than quietly showing
   * a wrong address.
   */
  restricted?: boolean;
};

/**
 * The same listing, with everything VELTO sells stripped out.
 *
 * Done here, on the server, and not with a CSS class or a conditional in a
 * component: a price that reaches the browser has been given away, whatever
 * the page chooses to paint. The network response for a visitor without
 * access must not contain the exact position, the price, the dates or the
 * street address, because that response is one devtools panel away from being
 * read.
 *
 * What survives is deliberately enough to be useful: the type of sign, the
 * city, whether it is digital, and a position rounded to a neighbourhood. A
 * visitor can see that there are eleven spaces in Be'er Sheva and roughly
 * where they cluster - which is the argument for signing up.
 */
export function redactForRestricted(asset: MapAsset): MapAsset {
  return {
    ...asset,
    /*
     * The owner's title often contains the street ("שלט חוצות - כניסה לעיר,
     * דרך חברון"), so it cannot survive. What replaces it was the city, which
     * made a shortlist of ten read as ten identical cards called "באר שבע" -
     * technically redacted and useless as a ranking.
     *
     * The type of sign is already public on the card, distinguishes the rows,
     * and gives away nothing: a digital screen is a digital screen whether or
     * not you can afford to find out where it is.
     */
    title: t(`type.${asset.assetType}`),
    address: "",
    latitude: coarse(asset.latitude),
    longitude: coarse(asset.longitude),
    priceMonthly: null,
    priceWeekly: null,
    nextAvailable: null,
    imageUrl: null,
    restricted: true,
  };
}

/**
 * Strip the filters that would answer a question the redaction refuses to.
 *
 * Blanking a price in the response is not enough on its own. A filter is an
 * oracle: `maxPrice=4000` returning a sign and `maxPrice=3999` not returning
 * it states that sign's price to the shekel, and a dozen requests do it for
 * the whole map. The same trick reads the address out of the free-text search
 * one letter at a time, and the availability calendar out of a date range.
 *
 * So a viewer without access does not get those filters at all. They keep
 * everything that filters on what they are allowed to see anyway - the
 * viewport, the city, the type of sign, digital, verified.
 *
 * The UI hides these controls for the same viewer; this is the half that
 * matters, because the UI is not where the query is built.
 */
export function withoutSaleableFilters(q: MapQuery): MapQuery {
  return {
    ...q,
    minPrice: undefined,
    maxPrice: undefined,
    startDate: undefined,
    endDate: undefined,
    availability: undefined,
  };
}

function buildWhere(q: MapQuery, restricted = false): Prisma.MediaAssetWhereInput {
  const where: Prisma.MediaAssetWhereInput = { status: "ACTIVE" };

  if (q.minLat != null && q.maxLat != null) {
    where.latitude = { gte: q.minLat, lte: q.maxLat };
  }
  if (q.minLng != null && q.maxLng != null) {
    where.longitude = { gte: q.minLng, lte: q.maxLng };
  }
  if (q.city) where.city = { equals: q.city, mode: "insensitive" };
  if (q.q) {
    // Free text is narrowed rather than removed for a restricted viewer. The
    // address and the title (which carries the street) are withheld, so
    // searching them would read them back out one letter at a time; the city
    // is on the card either way, so searching it gives nothing away and keeps
    // the box usable.
    where.OR = restricted
      ? [{ city: { contains: q.q, mode: "insensitive" } }]
      : [
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

/**
 * How many rows the database is asked for before availability is applied.
 *
 * Availability is derived in JS from declared periods minus approved bookings,
 * so it cannot be a SQL predicate. That leaves one ordering question that was
 * previously answered wrongly: the old code took `limit` rows and *then*
 * dropped the ones whose availability did not match, so asking for "available
 * only" returned whatever survived out of the first page rather than the first
 * page of available listings. A map that shows nine of the twenty free signs
 * in a city, with no indication that it did so, is worse than one that shows
 * none.
 *
 * So the ceiling is separate from the caller's limit: read generously, filter,
 * then cut - and say so when the ceiling was actually hit.
 */
const SCAN_CEILING = 3000;

export type MapResult = {
  assets: MapAsset[];
  /** Matching ACTIVE listings before the availability filter and the limit. */
  total: number;
  /** True when more matched than were returned: the map is showing a subset. */
  truncated: boolean;
};

export async function queryMapAssets(q: MapQuery): Promise<MapAsset[]> {
  return (await queryMap(q)).assets;
}

/**
 * The map query, with the access rule applied in one place.
 *
 * Callers pass the viewer's access rather than pre-filtering the query
 * themselves: the leak this closed was not a missing check, it was two call
 * sites (the API route and the server-rendered first paint) that each had to
 * remember the same thing.
 */
export async function queryMap(q: MapQuery, opts: { restricted?: boolean } = {}): Promise<MapResult> {
  const restricted = opts.restricted ?? false;
  const effective = restricted ? withoutSaleableFilters(q) : q;

  const window =
    effective.startDate && effective.endDate
      ? { start: toUtcDate(effective.startDate), end: toUtcDate(effective.endDate) }
      : undefined;

  const where = buildWhere(effective, restricted);
  const [total, rows] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      // Only an availability filter needs the generous read; without one the
      // caller's limit is already the right cut.
      take: effective.availability ? SCAN_CEILING : effective.limit,
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
    }),
  ]);

  const today = todayUtc();
  const wanted = effective.availability?.split(",").filter(Boolean) as AvailabilityState[] | undefined;

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

  // Filter first, cut second. The other order is the bug this replaced.
  const matching = wanted?.length ? mapped.filter((a) => wanted.includes(a.availability)) : mapped;
  const assets = matching.slice(0, effective.limit);

  return {
    assets,
    total,
    // Either the database had more rows than we asked for, or the availability
    // filter had more survivors than the limit. Both mean the same thing to a
    // user - you are looking at part of the answer - and the map says so.
    truncated: assets.length < matching.length || total > rows.length,
  };
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
