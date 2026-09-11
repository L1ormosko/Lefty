import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma, TEST_TAG } from "./factories";
import { runBrief } from "@/server/brief";
import { expiringForOwner, freeingSoon } from "@/server/expiring";
import { EMPTY_BRIEF, type Brief } from "@/lib/brief";
import { addDays, isoDate, todayUtc } from "@/lib/dates";

/**
 * The brief and the contract-expiry views against a real database.
 *
 * These exist because the interesting failures are not in the arithmetic - the
 * pure tests cover that - but in what the query does and does not return: an
 * unpublished draft leaking into a shortlist, or a price appearing for an asset
 * whose owner never set one.
 */

const today = todayUtc();
const CITY = "עיר בדיקה";

let ownerId: string;
let otherOwnerId: string;
let advertiserId: string;
let freeAssetId: string;
let bookedAssetId: string;
let draftAssetId: string;
let unpricedAssetId: string;

function brief(overrides: Partial<Brief> = {}): Brief {
  return { ...EMPTY_BRIEF, cities: [CITY], ...overrides };
}

beforeAll(async () => {
  await cleanup();
  ownerId = (await makeUser("MEDIA_OWNER")).id;
  otherOwnerId = (await makeUser("MEDIA_OWNER")).id;
  advertiserId = (await makeUser("ADVERTISER")).id;

  freeAssetId = (await makeAsset(ownerId, { city: CITY, title: `${TEST_TAG} free` })).id;
  bookedAssetId = (await makeAsset(ownerId, { city: CITY, title: `${TEST_TAG} booked` })).id;
  unpricedAssetId = (
    await makeAsset(otherOwnerId, {
      city: CITY,
      title: `${TEST_TAG} unpriced`,
      priceMonthly: null,
      priceWeekly: null,
    })
  ).id;
  draftAssetId = (
    await makeAsset(ownerId, { city: CITY, title: `${TEST_TAG} draft`, status: "DRAFT" })
  ).id;

  // Takes the whole of the window the briefs below ask about, and ends inside
  // the expiry horizon - so one booking drives both features.
  await prisma.booking.create({
    data: {
      assetId: bookedAssetId,
      advertiserId,
      startDate: addDays(today, 1),
      endDate: addDays(today, 20),
      status: "APPROVED",
      decidedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("running a brief", () => {
  it("never returns an asset that is not public", async () => {
    const results = await runBrief(brief());
    const ids = results.map((r) => r.assetId);
    expect(ids).toContain(freeAssetId);
    // A draft is the owner's private work in progress, whatever it scores.
    expect(ids).not.toContain(draftAssetId);
  });

  it("ranks a free asset above the same asset booked for those dates", async () => {
    const results = await runBrief(
      brief({ startDate: isoDate(addDays(today, 2)), endDate: isoDate(addDays(today, 10)) })
    );
    const free = results.findIndex((r) => r.assetId === freeAssetId);
    const booked = results.findIndex((r) => r.assetId === bookedAssetId);
    expect(free).toBeGreaterThanOrEqual(0);
    expect(booked).toBeGreaterThan(free);
  });

  it("still surfaces the booked asset, with the date it frees up", async () => {
    const results = await runBrief(
      brief({ startDate: isoDate(addDays(today, 2)), endDate: isoDate(addDays(today, 10)) })
    );
    const booked = results.find((r) => r.assetId === bookedAssetId);
    expect(booked?.asset.availability).toBe("OCCUPIED");
    expect(booked?.asset.nextAvailable).toBe(isoDate(addDays(today, 21)));
  });

  it("reports no price for an asset whose owner published none", async () => {
    const results = await runBrief(
      brief({
        startDate: isoDate(addDays(today, 2)),
        endDate: isoDate(addDays(today, 40)),
        budget: 100000,
      })
    );
    const unpriced = results.find((r) => r.assetId === unpricedAssetId);
    // Not a zero and not an estimate: the honest answer is "nobody said".
    expect(unpriced?.asset.priceEstimate).toBeNull();
    expect(unpriced?.gaps).toContain("brief.gap.noPrice");
  });

  it("gives no price at all when the brief has no dates to price", async () => {
    const results = await runBrief(brief());
    // A monthly rate is not a campaign price. Without a window there is
    // nothing to compute, so nothing is shown.
    expect(results.every((r) => r.asset.priceEstimate === null)).toBe(true);
  });
});

describe("contracts about to end", () => {
  it("shows the owner their own bookings only", async () => {
    const mine = await expiringForOwner(ownerId);
    expect(mine.map((b) => b.assetId)).toContain(bookedAssetId);

    const theirs = await expiringForOwner(otherOwnerId);
    expect(theirs.map((b) => b.assetId)).not.toContain(bookedAssetId);
  });

  it("counts the days left from the end date, not from a stored field", async () => {
    const [first] = await expiringForOwner(ownerId);
    expect(first.endDate).toBe(isoDate(addDays(today, 20)));
    expect(first.daysLeft).toBe(20);
  });

  it("ignores a booking that ends after the horizon", async () => {
    expect(await expiringForOwner(ownerId, 5)).toEqual([]);
  });

  it("tells an advertiser when a public asset frees up", async () => {
    const freeing = await freeingSoon(45, 50);
    const entry = freeing.find((f) => f.assetId === bookedAssetId);
    expect(entry?.freesOn).toBe(isoDate(addDays(today, 20)));
  });
});
