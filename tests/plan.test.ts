import { describe, expect, it } from "vitest";
import { expiresWithin, planStatus, type OwnerPlan } from "@/lib/plan";

const NOW = new Date("2026-09-12T00:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function plan(overrides: Partial<OwnerPlan> = {}): OwnerPlan {
  return { activeListingLimit: 3, paidThrough: days(30), ...overrides };
}

describe("an owner with no plan row", () => {
  it("is unlimited, because every owner today predates billing", () => {
    // Adding a table must never quietly cap the people already on the platform.
    const status = planStatus(null, 47, NOW);
    expect(status.limit).toBeNull();
    expect(status.remaining).toBeNull();
    expect(status.canPublish).toBe(true);
    expect(status.lapsed).toBe(false);
  });
});

describe("the listing limit", () => {
  it("allows publishing while there is room", () => {
    const status = planStatus(plan(), 2, NOW);
    expect(status.remaining).toBe(1);
    expect(status.canPublish).toBe(true);
  });

  it("blocks the one that would exceed it", () => {
    const status = planStatus(plan(), 3, NOW);
    expect(status.remaining).toBe(0);
    expect(status.canPublish).toBe(false);
    expect(status.block).toBe("limit");
  });

  it("never reports a negative remainder", () => {
    // An owner moved onto a smaller plan is over it. "-2 remaining" is a number
    // no screen should have to phrase, and their live listings stay up anyway.
    const status = planStatus(plan({ activeListingLimit: 1 }), 3, NOW);
    expect(status.remaining).toBe(0);
    expect(status.canPublish).toBe(false);
  });
});

describe("a lapsed subscription", () => {
  it("blocks publishing something new", () => {
    const status = planStatus(plan({ paidThrough: days(-1) }), 0, NOW);
    expect(status.lapsed).toBe(true);
    expect(status.canPublish).toBe(false);
    expect(status.block).toBe("lapsed");
  });

  it("is reported as lapsed rather than as a limit, even when both are true", () => {
    // The two have different fixes; saying "limit" to someone whose card
    // expired sends them to the wrong place.
    const status = planStatus(plan({ paidThrough: days(-1), activeListingLimit: 1 }), 5, NOW);
    expect(status.block).toBe("lapsed");
  });

  it("does not take anything already live off the map", () => {
    // The rule that matters most: an advertiser who found a billboard
    // yesterday must still find it today. Nothing in a lapse touches asset
    // status - the count is reported back unchanged, and the only thing
    // withheld is the right to add another.
    const status = planStatus(plan({ paidThrough: days(-90) }), 12, NOW);
    expect(status.activeCount).toBe(12);
    expect(status.canPublish).toBe(false);
  });

  it("treats a plan with no end date as paid", () => {
    expect(planStatus(plan({ paidThrough: null }), 0, NOW).lapsed).toBe(false);
  });
});

describe("warning before the block bites", () => {
  it("notices a subscription about to run out", () => {
    expect(expiresWithin(plan({ paidThrough: days(5) }), 14, NOW)).toBe(true);
    expect(expiresWithin(plan({ paidThrough: days(30) }), 14, NOW)).toBe(false);
  });

  it("says nothing about a plan that has already lapsed", () => {
    // That is not a warning any more, it is a state, and planStatus reports it.
    expect(expiresWithin(plan({ paidThrough: days(-1) }), 14, NOW)).toBe(false);
  });

  it("says nothing when there is no plan at all", () => {
    expect(expiresWithin(null, 14, NOW)).toBe(false);
    expect(expiresWithin(plan({ paidThrough: null }), 14, NOW)).toBe(false);
  });
});
