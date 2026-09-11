import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { availabilityFor, estimatePrice, nextAvailableDate } from "@/lib/availability";
import { daysBetween, toUtcDate, todayUtc } from "@/lib/dates";
import { rankAssets, type Brief, type Match, type ScorableAsset } from "@/lib/brief";

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

export async function runBrief(brief: Brief, limit = 24): Promise<Recommendation[]> {
  const where: Prisma.MediaAssetWhereInput = { status: "ACTIVE" };
  if (brief.cities.length) where.city = { in: brief.cities };
  if (brief.digitalOnly) where.isDigital = true;
  if (brief.verifiedOnly) where.verificationStatus = "VERIFIED";
  // Asset type and location tags are scored rather than filtered: an
  // advertiser who asked for a billboard next to a mall should still see the
  // excellent digital screen across the road, ranked below it.

  const rows = await prisma.mediaAsset.findMany({
    where,
    // A ceiling rather than the brief's limit: the ranking happens after the
    // query, so cutting here would throw away candidates before scoring them.
    take: 500,
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

  const window = briefWindow(brief);
  const from = window?.start ?? todayUtc();
  const days = window ? daysBetween(window.start, window.end) : 0;

  const scorable: ScorableAsset[] = [];
  const byId = new Map<string, Recommendation["asset"]>();

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

  return rankAssets(scorable, brief)
    .filter((m) => m.score > 0)
    .slice(0, limit)
    .map((m) => ({ ...m, asset: byId.get(m.assetId)! }));
}
