import { describe, expect, it } from "vitest";
import { bandsOverlap, expiryFrom, hasExpired, normalizeApprovalDetails, policyCoversAmount, resolvePolicy, tallyDecisions } from "@/lib/approval-rules";

const policy = (id: string, min: bigint, max: bigint | null, requiredApprovals = 1, currency = "USD") => ({ id, currency, minAmountMinor: min, maxAmountMinor: max, requiredApprovals });
const usd = (amountMinor: bigint) => ({ amountMinor, currency: "USD" });

describe("policy bands", () => {
  it("covers min inclusive and max exclusive, in the same currency only", () => {
    const band = policy("p", 100n, 500n);
    expect(policyCoversAmount(band, usd(100n))).toBe(true);
    expect(policyCoversAmount(band, usd(499n))).toBe(true);
    expect(policyCoversAmount(band, usd(500n))).toBe(false);
    expect(policyCoversAmount(band, usd(99n))).toBe(false);
    expect(policyCoversAmount(band, { amountMinor: 200n, currency: "EUR" })).toBe(false);
    expect(policyCoversAmount(policy("open", 500n, null), usd(10n ** 15n))).toBe(true);
  });

  it("detects overlapping bands; adjacent bands do not overlap", () => {
    expect(bandsOverlap(policy("a", 0n, 500n), policy("b", 500n, null))).toBe(false);
    expect(bandsOverlap(policy("a", 0n, 501n), policy("b", 500n, null))).toBe(true);
    expect(bandsOverlap(policy("a", 0n, null), policy("b", 1_000n, 2_000n))).toBe(true);
    expect(bandsOverlap(policy("a", 0n, null), policy("b", 0n, null, 1, "EUR"))).toBe(false);
  });
});

describe("resolvePolicy", () => {
  const tiers = [policy("small", 0n, 50_000n, 1), policy("large", 50_000n, null, 2)];

  it("picks the band of the amount", () => {
    expect(resolvePolicy(tiers, usd(49_999n))).toMatchObject({ kind: "policy", policy: { id: "small" } });
    expect(resolvePolicy(tiers, usd(50_000n))).toMatchObject({ kind: "policy", policy: { id: "large" } });
  });

  it("needs no approval without policies or in a gap between bands", () => {
    expect(resolvePolicy([], usd(1n))).toEqual({ kind: "none" });
    expect(resolvePolicy([policy("over-1000", 100_000n, null)], usd(5n))).toEqual({ kind: "none" });
  });

  it("refuses a currency the subject type has no policy for (never fail open)", () => {
    expect(resolvePolicy(tiers, { amountMinor: 10n, currency: "EUR" })).toEqual({ kind: "currency_not_covered" });
  });

  it("uses any active policy for an amount-less subject, and the strictest when several match", () => {
    expect(resolvePolicy([policy("cost", 0n, null)], null)).toMatchObject({ kind: "policy", policy: { id: "cost" } });
    expect(resolvePolicy([policy("a", 0n, null, 1), policy("b", 0n, null, 2)], usd(5n))).toMatchObject({ policy: { id: "b" } });
  });
});

describe("tallyDecisions", () => {
  it("approves after the required number of different people", () => {
    expect(tallyDecisions(1, [{ deciderId: "u1", decision: "APPROVE" }])).toBe("APPROVED");
    expect(tallyDecisions(2, [{ deciderId: "u1", decision: "APPROVE" }])).toBe("PENDING");
    expect(tallyDecisions(2, [{ deciderId: "u1", decision: "APPROVE" }, { deciderId: "u1", decision: "APPROVE" }])).toBe("PENDING");
    expect(tallyDecisions(2, [{ deciderId: "u1", decision: "APPROVE" }, { deciderId: "u2", decision: "APPROVE" }])).toBe("APPROVED");
  });

  it("any rejection ends the request", () => {
    expect(tallyDecisions(2, [{ deciderId: "u1", decision: "APPROVE" }, { deciderId: "u2", decision: "REJECT" }])).toBe("REJECTED");
  });
});

describe("expiry", () => {
  it("expires at or after expiresAt; no expiry without one", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(expiryFrom(now, 2)?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    expect(expiryFrom(now, null)).toBeNull();
    expect(hasExpired(now, now)).toBe(true);
    expect(hasExpired(new Date(now.getTime() + 1), now)).toBe(false);
    expect(hasExpired(null, now)).toBe(false);
  });
});

describe("normalizeApprovalDetails", () => {
  it("keeps ids, codes and numbers; bigint becomes a decimal string", () => {
    expect(normalizeApprovalDetails({ paymentId: "cm123", oldUnitCostMinor: 1_250n, quantity: 3, final: true, note: null })).toEqual({
      ok: true,
      details: { paymentId: "cm123", oldUnitCostMinor: "1250", quantity: 3, final: true, note: null },
    });
  });

  it("refuses free text, floats, nested objects and bad keys", () => {
    expect(normalizeApprovalDetails({ note: "Customer called twice" }).ok).toBe(false);
    expect(normalizeApprovalDetails({ amount: 12.5 }).ok).toBe(false);
    expect(normalizeApprovalDetails({ nested: { a: 1 } }).ok).toBe(false);
    expect(normalizeApprovalDetails({ "Bad-Key": 1 }).ok).toBe(false);
  });
});
