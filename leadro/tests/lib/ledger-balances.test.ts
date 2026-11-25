import { describe, expect, it } from "vitest";
import { derivePaymentStatus, summarizeLedger, type LedgerAmount } from "@/lib/ledger-balances";

const usd = (effectiveType: LedgerAmount["effectiveType"], amountMinor: bigint): LedgerAmount => ({ currency: "USD", effectiveType, amountMinor });

describe("summarizeLedger", () => {
  it("derives charged, collected, refunded and outstanding from signed entries", () => {
    const [balance] = summarizeLedger([usd("CHARGE", 50_000n), usd("PAYMENT", 20_000n), usd("PAYMENT", 10_000n), usd("REFUND", -5_000n)]);
    expect(balance).toMatchObject({
      currency: "USD",
      chargedMinor: 50_000n,
      billedMinor: 50_000n,
      collectedMinor: 30_000n,
      refundedMinor: 5_000n,
      netCollectedMinor: 25_000n,
      outstandingMinor: 25_000n,
      paymentStatus: "PARTIAL",
    });
  });

  it("counts a reversal under the type it reverses, so a reversed charge leaves nothing billed", () => {
    const [balance] = summarizeLedger([usd("CHARGE", 50_000n), usd("CHARGE", -50_000n)]);
    expect(balance).toMatchObject({ chargedMinor: 0n, outstandingMinor: 0n, paymentStatus: "NOT_CHARGED" });
  });

  it("keeps currencies apart and sorts them", () => {
    const balances = summarizeLedger([
      { currency: "USD", effectiveType: "CHARGE", amountMinor: 100n },
      { currency: "EUR", effectiveType: "CHARGE", amountMinor: 200n },
      { currency: "EUR", effectiveType: "PAYMENT", amountMinor: 200n },
    ]);
    expect(balances.map((b) => [b.currency, b.paymentStatus])).toEqual([
      ["EUR", "PAID"],
      ["USD", "UNPAID"],
    ]);
  });

  it("handles amounts beyond 2^53 exactly", () => {
    const big = 2n ** 60n;
    const [balance] = summarizeLedger([usd("CHARGE", big), usd("PAYMENT", big - 1n)]);
    expect(balance.outstandingMinor).toBe(1n);
  });

  it("treats adjustments as part of what is billed and keeps material cost separate", () => {
    const [balance] = summarizeLedger([usd("CHARGE", 1_000n), usd("ADJUSTMENT", -200n), usd("PAYMENT", 800n), usd("MATERIAL_COST", -300n)]);
    expect(balance).toMatchObject({ billedMinor: 800n, outstandingMinor: 0n, materialCostMinor: 300n, paymentStatus: "PAID" });
  });
});

describe("derivePaymentStatus", () => {
  const status = (billedMinor: bigint, netCollectedMinor: bigint, refundedMinor = 0n) => derivePaymentStatus({ billedMinor, netCollectedMinor, refundedMinor });
  it("covers every status", () => {
    expect(status(0n, 0n)).toBe("NOT_CHARGED");
    expect(status(100n, 0n)).toBe("UNPAID");
    expect(status(100n, 40n)).toBe("PARTIAL");
    expect(status(100n, 100n)).toBe("PAID");
    expect(status(100n, 150n)).toBe("OVERPAID");
    expect(status(0n, 10n)).toBe("OVERPAID");
    expect(status(100n, 0n, 100n)).toBe("REFUNDED");
    expect(status(100n, 60n, 40n)).toBe("PARTIAL");
  });
});
