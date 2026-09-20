import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { t } from "@/lib/labels";
import { availabilityFor, estimatePrice, nextAvailableDate } from "@/lib/availability";
import { daysBetween, toUtcDate, todayUtc } from "@/lib/dates";
import { mergeTopMatches, rankAssets, type Brief, type Match, type ScorableAsset } from "@/lib/brief";

/**
 * Running a brief against the real inventory.
 *
 * The database work is here and the judgement is in lib/brief.ts, which is
 * pure. That split is the point: the ranking can be tested without a database,
 * and - more importantly - the optional language model sits on the far side of
 * it and cannot touch a result. The model's only job is text -> Brief; from
 * there on, every number comes from a column or from the booking calendar.
 */

export type Recommendation = Match & {
  asset: {
    id: string;
    title: string;
    city: string;
    address: string;
    assetType: string;
    isDigital: boolean;
    locationTags: string[];
    widthCm: number | null;
    heightCm: number | null;
    verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
    isDemo: boolean;
    imageUrl: string | null;
    availability: ScorableAsset["availability"];
    priceEstimate: number | null;
    nextAvailable: string | null;
    /** True when this row was blurred for a viewer without access. */
    restricted?: boolean;
  };
};

/**
 * The window a brief is scored against.
 *
 * With no dates the brief is still answerable - "what do you have in Be'er
 * Sheva at all" is a real question - so availability falls back to its
 * no-window meaning rather than inventing a period the advertiser never asked
 * for.
 */
function briefWindow(brief: Brief): { start: Date; end: Date } | undefined {
  if (!brief.startDate || !brief.endDate) return undefined;
  const start = toUtcDate(brief.startDate);
  const end = toUtcDate(brief.endDate);
  return end >= start ? { start, end } : undefined;
}

/**
 * The same recommendation with everything VELTO sells removed.
 *
 * The brief was the hole in the paywall: it ranks the real inventory and used
 * to hand an anonymous visitor the street address, a priced estimate and the
 * date each sign frees up - the whole of what the map is careful not to give
 * away. The ranking itself is not the product and stays visible; what it
 * ranked is.
 *
 * Same rule as redactForRestricted() in server/assets.ts: the reasons and the
 * gaps survive, because they are about the match rather than about the site.
 */
export function redactRecommendation(match: Recommendation): Recommendation {
  return {
    ...match,
    asset: {
      ...match.asset,
      // Titles carry street names ("שלט חוצות - דרך חברון"). The type of sign
      // is public anyway and tells the rows apart - see redactForRestricted().
      title: t(`type.${match.asset.assetType}`),
      address: "",
      priceEstimate: null,
      nextAvailable: null,
      imageUrl: null,
      restricted: true,
    },
  };
}

export async function runBrief(brief: Brief, limit = 24): Promise<Recommendation[]> {
  const where: Prisma.MediaAssetWhereInput = { status: "ACTIVE" };
  if (brief.cities.length) where.city = { in: brief.cities };
  if (brief.digitalOnly) where.isDigital = true;
  if (brief.verifiedOnly) where.verificationStatus = "VERIFIED";
  // Asset type and location tags are scored rather than filtered: an
  // advertiser who asked for a billboard next to a mall should still see the
  // excellent digital screen across the road, ranked below it.

  const window = briefWindow(brief);
  const from = window?.start ?? todayUtc();
  const days = window ? daysBetween(window.start, window.end) : 0;

  /*
   * Every active listing is scored, a page at a time.
   *
   * This used to be one query with `take: 500` and the ranking done after it,
   * which meant the shortlist was only correct while the inventory was
   * smaller than the ceiling. Past 500 the best match in the country could sit
   * at row 501 and never be looked at - and nothing about the answer would say
   * so. A marketplace whose recommendations quietly stop covering the
   * inventory is worse than one that is slow.
   *
   * Paging is sound here because scoreAsset is absolute: no score depends on
   * the other candidates, so a page merged into the running best is the same
   * answer as scoring everything at once (see mergeTopMatches). Ordering by id
   * rather than by verification gives the cursor a unique, stable key, which
   * is what keeps a page boundary from skipping or repeating a row.
   *
   * Cost scales with inventory rather than being capped: one query at pilot
   * size, ten at five thousand listings. Memory does not - only the running
   * best `limit` records are held, and each page is discarded once scored.
   */
  const PAGE = 500;
  let cursor: string | undefined;
  let best: Match[] = [];
  const byId = new Map<string, Recommendation["asset"]>();

  for (;;) {
    const rows = await prisma.mediaAsset.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        city: true,
        address: true,
        assetType: true,
        isDigital: true,
        locationTags: true,
        widthCm: true,
        heightCm: true,
        priceWeekly: true,
        priceMonthly: true,
        status: true,
        verificationStatus: true,
        isDemo: true,
        images: { where: { isPrimary: true }, take: 1, select: { url: true } },
        periods: { select: { startDate: true, endDate: true } },
        bookings: { where: { status: "APPROVED" }, select: { startDate: true, endDate: true } },
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const scorable: ScorableAsset[] = [];

    for (const r of rows) {
      const input = {
        status: r.status,
        verificationStatus: r.verificationStatus,
        periods: r.periods,
        approvedBookings: r.bookings,
      };
      const availability = availabilityFor(input, window);
      const next = nextAvailableDate(input, from);
      // Null when the owner published no price, or when the brief has no dates
      // to price. Never a made-up number.
      const priceEstimate = days > 0 ? estimatePrice(r, days) : null;

      scorable.push({
        id: r.id,
        city: r.city,
        assetType: r.assetType,
        isDigital: r.isDigital,
        locationTags: r.locationTags,
        widthCm: r.widthCm,
        heightCm: r.heightCm,
        verificationStatus: r.verificationStatus,
        hasImage: r.images.length > 0,
        availability,
        priceEstimate,
        nextAvailable: next ? next.toISOString().slice(0, 10) : null,
      });

      byId.set(r.id, {
        id: r.id,
        title: r.title,
        city: r.city,
        address: r.address,
        assetType: r.assetType,
        isDigital: r.isDigital,
        locationTags: r.locationTags,
        widthCm: r.widthCm,
        heightCm: r.heightCm,
        verificationStatus: r.verificationStatus,
        isDemo: r.isDemo,
        imageUrl: r.images[0]?.url ?? null,
        availability,
        priceEstimate,
        nextAvailable: next ? next.toISOString().slice(0, 10) : null,
      });
    }

    const scored = rankAssets(scorable, brief).filter((m) => m.score > 0);
    best = mergeTopMatches(best, scored, limit);

    // Drop the records that did not survive the merge. Without this the map
    // grows with the inventory and the paging saves nothing.
    const keep = new Set(best.map((m) => m.assetId));
    for (const id of byId.keys()) if (!keep.has(id)) byId.delete(id);

    // A short page is the last page.
    if (rows.length < PAGE) break;
  }

  return best.map((m) => ({ ...m, asset: byId.get(m.assetId)! }));
}
