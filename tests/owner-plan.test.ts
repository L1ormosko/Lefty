import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { ownerPlanStatus } from "@/server/plan";

/**
 * The subscription against a real database.
 *
 * The pure rules live in tests/plan.test.ts; what is checked here is the thing
 * the rules are useless without - that the count the limit is compared against
 * is the same count a buyer sees on the map, and that a lapse leaves those
 * rows exactly where they were.
 */

let ownerId: string;

beforeEach(async () => {
  await cleanup();
  ownerId = (await makeUser("MEDIA_OWNER")).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

describe("counting what is published", () => {
  it("counts ACTIVE listings only, the same set the map shows", async () => {
    await makeAsset(ownerId, { status: "ACTIVE" });
    await makeAsset(ownerId, { status: "DRAFT" });
    await makeAsset(ownerId, { status: "INACTIVE" });

    const status = await ownerPlanStatus(ownerId);
    expect(status.activeCount).toBe(1);
  });

  it("leaves an owner with no plan row unlimited", async () => {
    await makeAsset(ownerId, { status: "ACTIVE" });
    const status = await ownerPlanStatus(ownerId);
    expect(status.limit).toBeNull();
    expect(status.canPublish).toBe(true);
  });

  it("does not count another owner's listings against this one", async () => {
    const other = await makeUser("MEDIA_OWNER");
    await makeAsset(other.id, { status: "ACTIVE" });
    await prisma.ownerPlan.create({ data: { userId: ownerId, activeListingLimit: 1 } });

    const status = await ownerPlanStatus(ownerId);
    expect(status.activeCount).toBe(0);
    expect(status.canPublish).toBe(true);
  });
});

describe("a plan that is full or lapsed", () => {
  it("stops the next listing once the limit is reached", async () => {
    await prisma.ownerPlan.create({ data: { userId: ownerId, activeListingLimit: 1 } });
    await makeAsset(ownerId, { status: "ACTIVE" });

    const status = await ownerPlanStatus(ownerId);
    expect(status.canPublish).toBe(false);
    expect(status.block).toBe("limit");
  });

  it("blocks on a date that has passed, with no job having run to notice", async () => {
    // The lapse is derived from the clock on read. Nothing scheduled anything;
    // the row was written once and is simply old.
    await prisma.ownerPlan.create({
      data: { userId: ownerId, activeListingLimit: 5, paidThrough: days(-1) },
    });

    const status = await ownerPlanStatus(ownerId);
    expect(status.lapsed).toBe(true);
    expect(status.canPublish).toBe(false);
  });

  it("leaves every live listing live", async () => {
    // The promise made to advertisers: inventory does not disappear from the
    // map because of a bill between VELTO and the owner.
    await prisma.ownerPlan.create({
      data: { userId: ownerId, activeListingLimit: 1, paidThrough: days(-30) },
    });
    await makeAsset(ownerId, { status: "ACTIVE" });
    await makeAsset(ownerId, { status: "ACTIVE" });

    const status = await ownerPlanStatus(ownerId);
    expect(status.canPublish).toBe(false);

    const stillPublic = await prisma.mediaAsset.count({
      where: { ownerId, status: "ACTIVE" },
    });
    expect(stillPublic).toBe(2);
    expect(status.activeCount).toBe(2);
  });
});
