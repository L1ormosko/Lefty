import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { queryMapAssets } from "@/server/assets";
import { mapQuerySchema } from "@/lib/validation";
import { addDays, isoDate, todayUtc } from "@/lib/dates";

let ownerId: string;
let activeId: string;
let draftId: string;
let pendingId: string;
let farAwayId: string;

const query = (overrides: Record<string, unknown> = {}) => mapQuerySchema.parse(overrides);

beforeAll(async () => {
  await cleanup();
  ownerId = (await makeUser("MEDIA_OWNER")).id;
  activeId = (await makeAsset(ownerId, { city: "באר שבע", priceMonthly: 5000 })).id;
  draftId = (await makeAsset(ownerId, { status: "DRAFT" })).id;
  pendingId = (await makeAsset(ownerId, { verificationStatus: "PENDING" })).id;
  farAwayId = (await makeAsset(ownerId, { city: "חיפה", latitude: 32.79, longitude: 35.04 })).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("map query", () => {
  it("never returns draft assets", async () => {
    const ids = (await queryMapAssets(query())).map((a) => a.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(draftId);
  });

  it("restricts results to the requested bounding box", async () => {
    const beerSheva = await queryMapAssets(
      query({ minLat: 31.1, maxLat: 31.4, minLng: 34.6, maxLng: 34.9 })
    );
    const ids = beerSheva.map((a) => a.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(farAwayId);
  });

  it("filters by city", async () => {
    const haifa = await queryMapAssets(query({ city: "חיפה" }));
    expect(haifa.map((a) => a.id)).toContain(farAwayId);
    expect(haifa.map((a) => a.id)).not.toContain(activeId);
  });

  it("honours verifiedOnly", async () => {
    const verified = await queryMapAssets(query({ verifiedOnly: "1" }));
    expect(verified.map((a) => a.id)).not.toContain(pendingId);
  });

  it("marks an unverified asset as pending rather than available", async () => {
    const all = await queryMapAssets(query());
    const pending = all.find((a) => a.id === pendingId);
    expect(pending?.availability).toBe("PENDING_VERIFICATION");
  });

  it("derives OCCUPIED for a window taken by an approved booking", async () => {
    const advertiser = await makeUser("ADVERTISER");
    const asset = await makeAsset(ownerId);
    await prisma.booking.create({
      data: {
        assetId: asset.id,
        advertiserId: advertiser.id,
        startDate: addDays(todayUtc(), 10),
        endDate: addDays(todayUtc(), 40),
        status: "APPROVED",
      },
    });
    const results = await queryMapAssets(
      query({ startDate: isoDate(addDays(todayUtc(), 15)), endDate: isoDate(addDays(todayUtc(), 20)) })
    );
    expect(results.find((a) => a.id === asset.id)?.availability).toBe("OCCUPIED");
  });

  it("filters by published monthly price", async () => {
    const cheap = await queryMapAssets(query({ maxPrice: 1000 }));
    expect(cheap.map((a) => a.id)).not.toContain(activeId);
  });

  it("rejects an out-of-range bounding box at the schema level", () => {
    expect(mapQuerySchema.safeParse({ minLat: 999 }).success).toBe(false);
  });
});
