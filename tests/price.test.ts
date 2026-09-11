import { describe, expect, it } from "vitest";
import { formatAmount, priceLine } from "@/lib/price";
import { CURRENCY } from "@/lib/constants";

/**
 * The headline price line was written out by hand in five files. These tests
 * pin the two decisions that were being re-made each time: which rate gets
 * quoted, and what happens when there is no rate at all.
 */

describe("choosing which rate to quote", () => {
  it("prefers the monthly rate when both are published", () => {
    // Monthly is what owners quote and what the price filter searches on, so a
    // listing showing its weekly rate while being filtered on its monthly one
    // would be answering a different question than the one asked.
    const line = priceLine({ priceMonthly: 11000, priceWeekly: 3200 });
    expect(line.source).toBe("monthly");
    expect(line.amount).toBe(11000);
    expect(line.text).toContain("11,000");
  });

  it("falls back to the weekly rate when that is all there is", () => {
    const line = priceLine({ priceMonthly: null, priceWeekly: 3200 });
    expect(line.source).toBe("weekly");
    expect(line.amount).toBe(3200);
  });

  it("never presents one rate as the other", () => {
    const weeklyOnly = priceLine({ priceMonthly: null, priceWeekly: 3200 });
    const monthlyOnly = priceLine({ priceMonthly: 3200, priceWeekly: null });
    // Same number, different period - the words must differ.
    expect(weeklyOnly.per).not.toBe(monthlyOnly.per);
    expect(weeklyOnly.text).not.toBe(monthlyOnly.text);
  });
});

describe("when the owner published no price", () => {
  it("says so, and carries no number", () => {
    const line = priceLine({ priceMonthly: null, priceWeekly: null });
    expect(line.source).toBe("none");
    // Not a zero, and not an empty string that a caller might render as free.
    expect(line.amount).toBeNull();
    expect(line.per).toBeNull();
    expect(line.text.length).toBeGreaterThan(0);
    expect(line.text).not.toContain("0");
  });

  it("treats a missing field the same as an explicit null", () => {
    expect(priceLine({}).source).toBe("none");
  });
});

describe("formatting", () => {
  it("puts the shekel sign on the amount and groups thousands", () => {
    expect(formatAmount(11000)).toBe(`${CURRENCY}11,000`);
    expect(formatAmount(950)).toBe(`${CURRENCY}950`);
  });
});
