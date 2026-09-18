import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { validateRequestWindow } from "@/server/bookings";
import { addDays, todayUtc } from "@/lib/dates";

/**
 * The edge cases around a requested window.
 *
 * The date arithmetic is covered in availability.test.ts. What is pinned here
 * is the commercial rule that was missing: a request for dates that are
 * entirely sold used to be accepted, notify the owner, and land in their queue
 * as something the database would refuse to let them approve.
 */

let owner: { id: string };

beforeAll(async () => {
  await cleanup();
  owner = await makeUser("MEDIA_OWNER");
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const day = (n: number) => addDays(todayUtc(), n);

describe("requesting a window", () => {
  it("refuses dates the owner never offered, and says which problem it is", async () => {
    const asset = await makeAsset(owner.id, {
      periods: { create: [{ startDate: day(1), endDate: day(10) }] },
    });

    await expect(validateRequestWindow(asset.id, day(40), day(50))).rejects.toThrow(
      /אינו מוצע למכירה/
    );
  });

  it("refuses a window with nothing left in it", async () => {
    const asset = await makeAsset(owner.id, {
      periods: { create: [{ startDate: day(1), endDate: day(30) }] },
    });
    const advertiser = await makeUser("ADVERTISER");
    await prisma.booking.create({
      data: {
        assetId: asset.id,
        advertiserId: advertiser.id,
        startDate: day(1),
        endDate: day(30),
        status: "APPROVED",
      },
    });

    await expect(validateRequestWindow(asset.id, day(5), day(12))).rejects.toThrow(/כבר תפוסים/);
  });

  it("still allows a partly free window, because that is a fair question to ask", async () => {
    // The owner is the right person to answer "I want the whole month, you
    // have the first half" - refusing it would lose a real negotiation.
    const asset = await makeAsset(owner.id, {
      periods: { create: [{ startDate: day(1), endDate: day(30) }] },
    });
    const advertiser = await makeUser("ADVERTISER");
    await prisma.booking.create({
      data: {
        assetId: asset.id,
        advertiserId: advertiser.id,
        startDate: day(20),
        endDate: day(30),
        status: "APPROVED",
      },
    });

    const { days } = await validateRequestWindow(asset.id, day(1), day(30));
    expect(days).toBe(30);
  });

  it("keeps refusing the plain date mistakes", async () => {
    const asset = await makeAsset(owner.id, {
      periods: { create: [{ startDate: day(1), endDate: day(30) }] },
    });

    await expect(validateRequestWindow(asset.id, day(10), day(2))).rejects.toThrow();
    await expect(validateRequestWindow(asset.id, day(-5), day(5))).rejects.toThrow();
  });

  it("refuses a listing that is not public, whatever the dates", async () => {
    const hidden = await makeAsset(owner.id, {
      status: "INACTIVE",
      periods: { create: [{ startDate: day(1), endDate: day(30) }] },
    });

    await expect(validateRequestWindow(hidden.id, day(2), day(9))).rejects.toThrow();
  });
});
