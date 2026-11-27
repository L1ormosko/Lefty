import { describe, expect, it } from "vitest";
import {
  MAX_DRILL_DOWN_IDS,
  aggregateFacts,
  localDateRange,
  median,
  periodStartOf,
  placementAt,
  rangeLengthDays,
  rollUpToLevel,
  type KpiFact,
} from "@/lib/kpi-aggregation";

const NY = "America/New_York";
const fact = (recordId: string, overrides: Partial<KpiFact> = {}): KpiFact => ({ recordId, at: new Date("2026-03-10T15:00:00Z"), orgUnitId: "u1", ...overrides });
const flat = { periodOf: () => "2026-03-01", groupOf: (f: KpiFact) => f.orgUnitId, withBreakdown: false };

describe("period buckets in the tenant time zone", () => {
  it("puts an instant on the local date, not the UTC date", () => {
    // 02:00 UTC on 2026-03-11 is still the 10th in New York.
    expect(periodStartOf(new Date("2026-03-11T02:00:00Z"), "DAY", NY, "2026-03-01")).toBe("2026-03-10");
  });

  it("starts weeks on Monday and months on the 1st; TOTAL is one bucket", () => {
    expect(periodStartOf(new Date("2026-03-12T15:00:00Z"), "WEEK", NY, "2026-03-01")).toBe("2026-03-09");
    expect(periodStartOf(new Date("2026-03-15T15:00:00Z"), "WEEK", NY, "2026-03-01")).toBe("2026-03-09");
    expect(periodStartOf(new Date("2026-04-01T03:00:00Z"), "MONTH", NY, "2026-01-01")).toBe("2026-03-01");
    expect(periodStartOf(new Date("2026-06-01T12:00:00Z"), "TOTAL", NY, "2026-01-01")).toBe("2026-01-01");
  });

  it("turns a local date range into instants across a DST change", () => {
    const { start, end } = localDateRange("2026-03-08", "2026-03-08", NY); // clocks go forward that night
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(rangeLengthDays("2026-01-01", "2026-12-31")).toBe(365);
  });
});

describe("org roll-up and historical attribution", () => {
  const tree = new Map([
    ["state", { parentId: null, type: "STATE" }],
    ["city", { parentId: "state", type: "CITY" }],
    ["branch", { parentId: "city", type: "BRANCH" }],
    ["loose", { parentId: "state", type: "BRANCH" }],
  ]);

  it("finds the unit itself or its nearest ancestor of the level", () => {
    expect(rollUpToLevel("branch", "STATE", tree)).toBe("state");
    expect(rollUpToLevel("branch", "CITY", tree)).toBe("city");
    expect(rollUpToLevel("city", "CITY", tree)).toBe("city");
    expect(rollUpToLevel("branch", "TENANT", tree)).toBeNull();
  });

  it("returns null when no unit on the path has the level", () => {
    expect(rollUpToLevel("loose", "CITY", tree)).toBeNull();
    expect(rollUpToLevel(null, "STATE", tree)).toBeNull();
  });

  it("uses the placement effective at the event time, not the current one (spec 3)", () => {
    const placements = [
      { orgUnitId: "old", effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-03-01") },
      { orgUnitId: "new", effectiveFrom: new Date("2026-03-01"), effectiveTo: null },
    ];
    expect(placementAt(placements, new Date("2026-02-15"))).toBe("old");
    expect(placementAt(placements, new Date("2026-03-01"))).toBe("new");
    expect(placementAt(placements, new Date("2025-12-31"))).toBeNull();
  });
});

describe("aggregateFacts", () => {
  it("counts, and lists the source record ids", () => {
    const rows = aggregateFacts([fact("b"), fact("a"), fact("c", { orgUnitId: "u2" })], "COUNT", flat);
    expect(rows).toEqual([
      { periodStart: "2026-03-01", orgUnitId: "u1", value: 2, sampleCount: 2, recordIds: ["a", "b"], recordIdsTruncated: false },
      { periodStart: "2026-03-01", orgUnitId: "u2", value: 1, sampleCount: 1, recordIds: ["c"], recordIdsTruncated: false },
    ]);
  });

  it("returns numerator and denominator with a rate", () => {
    const [row] = aggregateFacts([fact("a", { hit: true }), fact("b", { hit: false }), fact("c", { hit: true }), fact("d", { hit: false })], "RATE", flat);
    expect(row).toMatchObject({ value: 0.5, numerator: 2, denominator: 4, sampleCount: 4 });
  });

  it("gives the median duration in seconds", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    const [row] = aggregateFacts([fact("a", { durationMs: 60_000 }), fact("b", { durationMs: 120_000 }), fact("c", { durationMs: 600_000 })], "DURATION", flat);
    expect(row).toMatchObject({ value: 120, sampleCount: 3 });
  });

  it("divides by distinct contributors for a ratio", () => {
    const facts = [fact("a", { contributorId: "e1" }), fact("b", { contributorId: "e1" }), fact("c", { contributorId: "e2" })];
    expect(aggregateFacts(facts, "RATIO", flat)[0]).toMatchObject({ value: 1.5, numerator: 3, denominator: 2 });
  });

  it("divides numerator records by the hours of the time base, listing only the numerator records", () => {
    const facts = [fact("job1"), fact("job2"), fact("job3"), fact("shift1", { hours: 4 }), fact("shift2", { hours: 2.004 })];
    expect(aggregateFacts(facts, "PER_HOUR", flat)[0]).toMatchObject({ numerator: 3, denominator: 6, sampleCount: 3, recordIds: ["job1", "job2", "job3"] });
    expect(aggregateFacts(facts, "PER_HOUR", flat)[0].value).toBeCloseTo(3 / 6.004);
    expect(aggregateFacts([fact("job1")], "PER_HOUR", flat)[0]).toMatchObject({ value: null, numerator: 1, denominator: 0 });
    expect(aggregateFacts([fact("shift1", { hours: 8 })], "PER_HOUR", flat)[0]).toMatchObject({ value: 0, numerator: 0, recordIds: [] });
  });

  it("never sums money across currencies", () => {
    const facts = [fact("a", { currency: "USD", amountMinor: 1000n }), fact("b", { currency: "EUR", amountMinor: 50n }), fact("c", { currency: "USD", amountMinor: 1n })];
    const rows = aggregateFacts(facts, "MONEY", flat);
    expect(rows.map((row) => [row.currency, row.value])).toEqual([["EUR", 50n], ["USD", 1001n]]);
  });

  it("keeps the breakdown as part of the group", () => {
    const rows = aggregateFacts([fact("a", { breakdownId: "web" }), fact("b", { breakdownId: null }), fact("c", { breakdownId: "web" })], "COUNT", { ...flat, withBreakdown: true });
    expect(rows.map((row) => [row.breakdownId, row.value])).toEqual([[null, 1], ["web", 2]]);
  });

  it("caps the drill-down ids and says so", () => {
    const facts = Array.from({ length: MAX_DRILL_DOWN_IDS + 3 }, (_, index) => fact(`r${String(index).padStart(3, "0")}`));
    const [row] = aggregateFacts(facts, "COUNT", flat);
    expect(row.recordIds).toHaveLength(MAX_DRILL_DOWN_IDS);
    expect(row.recordIdsTruncated).toBe(true);
    expect(row.value).toBe(MAX_DRILL_DOWN_IDS + 3);
  });
});
