import { describe, expect, it } from "vitest";
import { MAX_MONEY_MINOR, moneyAmountSchema, serializeJson, signedMoneyAmountSchema, stringifyJson, sumMinor } from "@/lib/money";

describe("moneyAmountSchema", () => {
  it("accepts a safe integer or a decimal string and returns a bigint", () => {
    expect(moneyAmountSchema.parse(12500)).toBe(12500n);
    expect(moneyAmountSchema.parse("12500")).toBe(12500n);
    expect(moneyAmountSchema.parse(" 0 ")).toBe(0n);
    expect(moneyAmountSchema.parse(MAX_MONEY_MINOR.toString())).toBe(MAX_MONEY_MINOR);
  });

  it("refuses floats, negatives, exponent forms, leading zeros, junk and values above the limit", () => {
    for (const bad of [1.5, -1, "1.5", "-1", "1e3", "007", "", "12 5", "abc", null, undefined, true, (MAX_MONEY_MINOR + 1n).toString(), Number.MAX_SAFE_INTEGER + 1]) {
      expect(moneyAmountSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("keeps amounts above the 32-bit range exact", () => {
    expect(moneyAmountSchema.parse("9000000000000")).toBe(9_000_000_000_000n);
  });
});

describe("signedMoneyAmountSchema", () => {
  it("accepts negative amounts and still refuses fractions", () => {
    expect(signedMoneyAmountSchema.parse(-500)).toBe(-500n);
    expect(signedMoneyAmountSchema.parse("-500")).toBe(-500n);
    expect(signedMoneyAmountSchema.safeParse("-0.5").success).toBe(false);
    expect(signedMoneyAmountSchema.safeParse((-MAX_MONEY_MINOR - 1n).toString()).success).toBe(false);
  });
});

describe("JSON serialization", () => {
  it("writes every bigint as a decimal string, deeply", () => {
    const value = { amountMinor: 9_007_199_254_740_993n, nested: [{ a: 1n }], count: 3, when: new Date("2026-01-02T03:04:05.000Z"), none: null };
    expect(JSON.parse(stringifyJson(value))).toEqual({ amountMinor: "9007199254740993", nested: [{ a: "1" }], count: 3, when: "2026-01-02T03:04:05.000Z", none: null });
    expect(serializeJson(value)).toEqual(JSON.parse(stringifyJson(value)));
  });
});

describe("sumMinor", () => {
  it("adds exactly and treats null as zero", () => {
    expect(sumMinor([9_000_000_000_000n, 1n, null, undefined])).toBe(9_000_000_000_001n);
    expect(sumMinor([])).toBe(0n);
  });
});
