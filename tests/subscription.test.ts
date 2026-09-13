import { describe, expect, it } from "vitest";
import {
  TRIAL_DAYS,
  access,
  coarse,
  trialEnd,
  trialEndingSoon,
  type Subscription,
} from "@/lib/subscription";

const NOW = new Date("2026-09-13T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return { trialEndsAt: null, paidThrough: null, ...overrides };
}

describe("who can see the inventory", () => {
  it("gives an anonymous visitor the restricted view, not an error", () => {
    // A marketplace nobody can look into cannot attract the side that pays.
    const a = access(null, NOW);
    expect(a.state).toBe("none");
    expect(a.full).toBe(false);
  });

  it("opens everything during the trial", () => {
    const a = access(sub({ trialEndsAt: days(5) }), NOW);
    expect(a.state).toBe("trial");
    expect(a.full).toBe(true);
    expect(a.trialDaysLeft).toBe(5);
  });

  it("opens everything while paid", () => {
    const a = access(sub({ paidThrough: days(60) }), NOW);
    expect(a.state).toBe("paid");
    expect(a.full).toBe(true);
  });

  it("prefers the payment over the trial when both are live", () => {
    // Someone who paid during their trial is a customer, not a trialist, and
    // should not be shown a countdown that is about to expire.
    const a = access(sub({ trialEndsAt: days(2), paidThrough: days(90) }), NOW);
    expect(a.state).toBe("paid");
    expect(a.trialDaysLeft).toBeNull();
  });

  it("closes the detail when the trial runs out", () => {
    const a = access(sub({ trialEndsAt: days(-1) }), NOW);
    expect(a.state).toBe("lapsed");
    expect(a.full).toBe(false);
  });

  it("closes the detail when the payment runs out", () => {
    const a = access(sub({ paidThrough: days(-1) }), NOW);
    expect(a.state).toBe("lapsed");
    expect(a.full).toBe(false);
  });

  it("tells a lapsed account apart from one that never had access", () => {
    // They read differently to the person on the screen and get different
    // copy: one is asked to renew, the other to start.
    expect(access(sub({ trialEndsAt: days(-9) }), NOW).state).toBe("lapsed");
    expect(access(sub(), NOW).state).toBe("none");
  });

  it("never rounds a part-day down to zero days left", () => {
    // Four hours left is "one day", not "zero", which would read as expired.
    const a = access(sub({ trialEndsAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000) }), NOW);
    expect(a.trialDaysLeft).toBe(1);
    expect(a.full).toBe(true);
  });

  it("counts the trial from the moment it is granted", () => {
    expect(trialEnd(NOW).getTime() - NOW.getTime()).toBe(TRIAL_DAYS * 24 * 60 * 60 * 1000);
    expect(access({ trialEndsAt: trialEnd(NOW), paidThrough: null }, NOW).full).toBe(true);
  });
});

describe("warning before the trial ends", () => {
  it("warns in the last few days and not before", () => {
    expect(trialEndingSoon(access(sub({ trialEndsAt: days(2) }), NOW))).toBe(true);
    expect(trialEndingSoon(access(sub({ trialEndsAt: days(6) }), NOW))).toBe(false);
  });

  it("says nothing to a paying customer or a lapsed one", () => {
    expect(trialEndingSoon(access(sub({ paidThrough: days(30) }), NOW))).toBe(false);
    expect(trialEndingSoon(access(sub({ trialEndsAt: days(-1) }), NOW))).toBe(false);
  });
});

describe("blurring a position for a restricted viewer", () => {
  it("keeps the pin in the right area and off the right corner", () => {
    // Be'er Sheva's centre. A few hundred metres of error is a neighbourhood,
    // which is the point: enough to show there is inventory here, not enough
    // to go and look at the sign instead of paying for the listing.
    const lat = 31.2518;
    const rounded = coarse(lat);
    const metres = Math.abs(rounded - lat) * 111_320;
    expect(metres).toBeLessThan(500);
    expect(metres).toBeGreaterThan(0);
  });

  it("is stable, so the same sign cannot be averaged out of hiding", () => {
    // Rounding rather than random noise: repeated loads return the identical
    // value, so nobody can collect samples and recover the true point.
    const first = coarse(34.79131);
    const second = coarse(34.79131);
    expect(first).toBe(second);
  });

  it("moves distinct nearby signs onto the same approximate spot", () => {
    // Two signs a street apart should not stay individually identifiable.
    expect(coarse(31.25181)).toBe(coarse(31.25219));
  });
});
