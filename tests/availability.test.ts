import { describe, expect, it } from "vitest";
import { availabilityFor, estimatePrice, nextAvailableDate } from "@/lib/availability";
import { daysBetween, rangesOverlap, toUtcDate } from "@/lib/dates";

const period = (s: string, e: string) => ({ startDate: toUtcDate(s), endDate: toUtcDate(e) });
const base = {
  status: "ACTIVE" as const,
  verificationStatus: "VERIFIED" as const,
  periods: [period("2026-01-01", "2026-03-31")],
  approvedBookings: [],
};

describe("date helpers", () => {
  it("counts inclusive days", () => {
    expect(daysBetween(toUtcDate("2026-01-01"), toUtcDate("2026-01-01"))).toBe(1);
    expect(daysBetween(toUtcDate("2026-01-01"), toUtcDate("2026-01-14"))).toBe(14);
  });

  it("treats touching ranges as overlapping and adjacent ones as free", () => {
    const a = [toUtcDate("2026-01-01"), toUtcDate("2026-01-10")] as const;
    expect(rangesOverlap(a[0], a[1], toUtcDate("2026-01-10"), toUtcDate("2026-01-20"))).toBe(true);
    expect(rangesOverlap(a[0], a[1], toUtcDate("2026-01-11"), toUtcDate("2026-01-20"))).toBe(false);
  });
});

describe("availabilityFor", () => {
  it("is AVAILABLE when the whole window sits inside a declared period", () => {
    const state = availabilityFor(base, { start: toUtcDate("2026-02-01"), end: toUtcDate("2026-02-14") });
    expect(state).toBe("AVAILABLE");
  });

  it("is OCCUPIED when the window is fully booked", () => {
    const state = availabilityFor(
      { ...base, approvedBookings: [period("2026-02-01", "2026-02-28")] },
      { start: toUtcDate("2026-02-05"), end: toUtcDate("2026-02-10") }
    );
    expect(state).toBe("OCCUPIED");
  });

  it("is PARTIAL when only part of the window is free", () => {
    const state = availabilityFor(
      { ...base, approvedBookings: [period("2026-02-01", "2026-02-07")] },
      { start: toUtcDate("2026-02-01"), end: toUtcDate("2026-02-14") }
    );
    expect(state).toBe("PARTIAL");
  });

  it("is OCCUPIED when the window falls outside every declared period", () => {
    const state = availabilityFor(base, { start: toUtcDate("2026-06-01"), end: toUtcDate("2026-06-10") });
    expect(state).toBe("OCCUPIED");
  });

  it("reports verification and inactive states before availability", () => {
    expect(availabilityFor({ ...base, verificationStatus: "PENDING" })).toBe("PENDING_VERIFICATION");
    expect(availabilityFor({ ...base, status: "INACTIVE" })).toBe("INACTIVE");
    expect(availabilityFor({ ...base, status: "DRAFT" })).toBe("INACTIVE");
  });

  it("never claims availability for an asset with no declared window", () => {
    expect(availabilityFor({ ...base, periods: [] })).toBe("OCCUPIED");
  });
});

describe("nextAvailableDate", () => {
  it("skips days taken by an approved booking", () => {
    const next = nextAvailableDate(
      { ...base, approvedBookings: [period("2026-01-01", "2026-01-15")] },
      toUtcDate("2026-01-01")
    );
    expect(next && next.toISOString().slice(0, 10)).toBe("2026-01-16");
  });

  it("returns null when nothing is sellable in the horizon", () => {
    expect(nextAvailableDate({ ...base, periods: [] }, toUtcDate("2026-01-01"))).toBeNull();
  });
});

describe("estimatePrice", () => {
  it("returns null when the owner published no price - never a guess", () => {
    expect(estimatePrice({ priceWeekly: null, priceMonthly: null }, 14)).toBeNull();
  });

  it("prorates from the weekly price for short windows", () => {
    expect(estimatePrice({ priceWeekly: 700, priceMonthly: null }, 14)).toBe(1400);
  });

  it("prefers the monthly price for windows of a month or more", () => {
    expect(estimatePrice({ priceWeekly: 700, priceMonthly: 3000 }, 30)).toBe(3000);
  });
});
