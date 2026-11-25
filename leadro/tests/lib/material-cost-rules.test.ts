import { describe, expect, it } from "vitest";
import {
  extendedCostMinor,
  isEffectiveAt,
  materialCodeFromRef,
  newVersionPlacementProblem,
  quantityToThousandths,
  unitsMatch,
} from "@/lib/material-cost-rules";

describe("quantityToThousandths", () => {
  it("reads Decimal(12,3) text exactly", () => {
    expect(quantityToThousandths("2.5")).toBe(2500n);
    expect(quantityToThousandths("2.500")).toBe(2500n);
    expect(quantityToThousandths("0.001")).toBe(1n);
    expect(quantityToThousandths("12")).toBe(12_000n);
    expect(quantityToThousandths("999999999.999")).toBe(999_999_999_999n);
  });

  it("refuses what the column cannot hold", () => {
    for (const bad of ["-1", "1.2345", "1e3", "", "01", "abc"]) expect(() => quantityToThousandths(bad)).toThrow();
  });
});

describe("extendedCostMinor: quantity x unit cost, half-even to whole minor units", () => {
  it("is exact when there is nothing to round", () => {
    expect(extendedCostMinor(2000n, 425n)).toBe(850n);
    expect(extendedCostMinor(250n, 400n)).toBe(100n);
    expect(extendedCostMinor(0n, 425n)).toBe(0n);
    expect(extendedCostMinor(1500n, 0n)).toBe(0n);
  });

  it("rounds an exact half to the even neighbour", () => {
    expect(extendedCostMinor(1500n, 425n)).toBe(638n); // 637.5 -> 638
    expect(extendedCostMinor(1500n, 423n)).toBe(634n); // 634.5 -> 634
    expect(extendedCostMinor(500n, 1n)).toBe(0n); // 0.5 -> 0
    expect(extendedCostMinor(1500n, 1n)).toBe(2n); // 1.5 -> 2
    expect(extendedCostMinor(2500n, 1n)).toBe(2n); // 2.5 -> 2
  });

  it("rounds anything else to the nearest unit", () => {
    expect(extendedCostMinor(1n, 499n)).toBe(0n); // 0.499
    expect(extendedCostMinor(1n, 501n)).toBe(1n); // 0.501
    expect(extendedCostMinor(333n, 100n)).toBe(33n); // 33.3
    expect(extendedCostMinor(337n, 100n)).toBe(34n); // 33.7
  });

  it("stays exact for the largest quantity and a large cost (bigint, no floats)", () => {
    expect(extendedCostMinor(999_999_999_999n, 999_999_999_999_999n)).toBe(999_999_999_998_999_000_000_000n);
  });

  it("refuses negative inputs", () => {
    expect(() => extendedCostMinor(-1n, 1n)).toThrow();
    expect(() => extendedCostMinor(1n, -1n)).toThrow();
  });
});

describe("units and references", () => {
  it("compares units trimmed and case-insensitively, without conversion", () => {
    expect(unitsMatch(" Each ", "each")).toBe(true);
    expect(unitsMatch("m", "ft")).toBe(false);
  });

  it("reads a free-text reference as a lower-case code", () => {
    expect(materialCodeFromRef(" PVC-Pipe-1in ")).toBe("pvc-pipe-1in");
    expect(materialCodeFromRef("  ")).toBeNull();
    expect(materialCodeFromRef(null)).toBeNull();
  });
});

describe("effective periods", () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const to = new Date("2026-02-01T00:00:00Z");

  it("includes the start and excludes the end", () => {
    expect(isEffectiveAt({ effectiveFrom: from, effectiveTo: to }, from)).toBe(true);
    expect(isEffectiveAt({ effectiveFrom: from, effectiveTo: to }, to)).toBe(false);
    expect(isEffectiveAt({ effectiveFrom: from, effectiveTo: null }, new Date("2999-01-01T00:00:00Z"))).toBe(true);
    expect(isEffectiveAt({ effectiveFrom: from, effectiveTo: null }, new Date("2025-12-31T23:59:59Z"))).toBe(false);
  });

  it("places a new version strictly after the current one and after every usage costed with it", () => {
    const current = { effectiveFrom: from, effectiveTo: null };
    expect(newVersionPlacementProblem({ effectiveFrom: to, current, latestCostedUsageAt: null })).toBeNull();
    expect(newVersionPlacementProblem({ effectiveFrom: from, current, latestCostedUsageAt: null })).toBe("not_after_current");
    expect(newVersionPlacementProblem({ effectiveFrom: to, current, latestCostedUsageAt: to })).toBe("costed_usage_after");
    expect(newVersionPlacementProblem({ effectiveFrom: to, current, latestCostedUsageAt: new Date(to.getTime() - 1) })).toBeNull();
    expect(newVersionPlacementProblem({ effectiveFrom: from, current: null, latestCostedUsageAt: null })).toBeNull();
  });
});
