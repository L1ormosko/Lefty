import { describe, expect, it } from "vitest";
import {
  canTransitionException,
  classifyJobBalance,
  classifyOutcomeCharge,
  classifyRefund,
  decideFinding,
  findingFingerprint,
  periodProblem,
  type ExistingException,
  type ReconciliationFinding,
} from "@/lib/reconciliation-rules";

const finding = (overrides: Partial<ReconciliationFinding> = {}): ReconciliationFinding => ({
  kind: "PARTIAL_PAYMENT",
  code: null,
  currency: "USD",
  jobId: "job-1",
  paymentId: null,
  intakeEventId: null,
  refundId: null,
  outcomeId: null,
  orgUnitId: "unit-1",
  expectedAmountMinor: 10_000n,
  recordedAmountMinor: 4_000n,
  ...overrides,
});

const existing = (overrides: Partial<ExistingException> = {}): ExistingException => ({ ...finding(), id: "exc-1", status: "OPEN", ...overrides });

describe("classifyJobBalance", () => {
  it.each([
    [10_000n, 0n, "UNPAID"],
    [10_000n, -500n, "UNPAID"],
    [10_000n, 4_000n, "PARTIAL_PAYMENT"],
    [10_000n, 10_000n, null],
    [10_000n, 12_000n, "OVERPAYMENT"],
    [0n, 3_000n, "OVERPAYMENT"],
    [0n, 0n, null],
    [-2_000n, 0n, null],
    [0n, -1_000n, null],
  ] as const)("billed %s, net collected %s -> %s", (billedMinor, netCollectedMinor, expected) => {
    expect(classifyJobBalance({ billedMinor, netCollectedMinor })).toBe(expected);
  });
});

describe("classifyOutcomeCharge", () => {
  it("agrees when the active charge equals the outcome and the collection was recorded", () => {
    expect(classifyOutcomeCharge({ chargedAmountMinor: 5_000n, collectedAmountMinor: 5_000n, activeChargeMinors: [5_000n], activeCollectionCount: 1 })).toBeNull();
  });

  it("reports a mismatch when the outcome was corrected after the charge was posted", () => {
    expect(classifyOutcomeCharge({ chargedAmountMinor: 4_000n, collectedAmountMinor: null, activeChargeMinors: [5_000n], activeCollectionCount: 0 })).toEqual({
      kind: "MISMATCH",
      postedMinor: 5_000n,
    });
    expect(classifyOutcomeCharge({ chargedAmountMinor: null, collectedAmountMinor: null, activeChargeMinors: [5_000n], activeCollectionCount: 0 })).toMatchObject({ kind: "MISMATCH" });
  });

  it("reports pending confirmation for an unconfirmed charge or collection", () => {
    expect(classifyOutcomeCharge({ chargedAmountMinor: 5_000n, collectedAmountMinor: 2_000n, activeChargeMinors: [], activeCollectionCount: 0 })).toEqual({
      kind: "PENDING",
      chargePending: true,
      collectionPending: true,
    });
    expect(classifyOutcomeCharge({ chargedAmountMinor: 5_000n, collectedAmountMinor: 2_000n, activeChargeMinors: [5_000n], activeCollectionCount: 0 })).toEqual({
      kind: "PENDING",
      chargePending: false,
      collectionPending: true,
    });
  });
});

describe("classifyRefund", () => {
  it("flags a refund with no payment only when the job has no received payment", () => {
    expect(classifyRefund({ payment: null, jobHasReceivedPayment: false })).toBe("refund_no_payment");
    expect(classifyRefund({ payment: null, jobHasReceivedPayment: true })).toBeNull();
  });

  it("flags a refund of a payment that is not received, or refunds exceeding the payment", () => {
    expect(classifyRefund({ payment: { status: "FAILED", amountMinor: 100n, refundedMinor: 50n }, jobHasReceivedPayment: true })).toBe("refund_payment_not_received");
    expect(classifyRefund({ payment: { status: "RECEIVED", amountMinor: 100n, refundedMinor: 150n }, jobHasReceivedPayment: true })).toBe("refund_exceeds_payment");
    expect(classifyRefund({ payment: { status: "RECEIVED", amountMinor: 100n, refundedMinor: 100n }, jobHasReceivedPayment: true })).toBeNull();
  });
});

describe("findings across runs", () => {
  it("the fingerprint ignores amounts and the unit, but not the kind or the records", () => {
    expect(findingFingerprint(finding())).toBe(findingFingerprint(finding({ recordedAmountMinor: 6_000n, orgUnitId: "unit-2" })));
    expect(findingFingerprint(finding())).not.toBe(findingFingerprint(finding({ kind: "UNPAID" })));
    expect(findingFingerprint(finding())).not.toBe(findingFingerprint(finding({ jobId: "job-2" })));
  });

  it("never duplicates an unresolved exception, even when the amounts moved", () => {
    expect(decideFinding(finding({ recordedAmountMinor: 6_000n }), [existing({ status: "ASSIGNED" })])).toEqual({ action: "ALREADY_OPEN", exceptionId: "exc-1" });
  });

  it("a resolution stands for the same amounts; moved amounts raise a new exception", () => {
    expect(decideFinding(finding(), [existing({ status: "RESOLVED" })])).toEqual({ action: "ACCEPTED", exceptionId: "exc-1" });
    expect(decideFinding(finding({ recordedAmountMinor: 1_000n }), [existing({ status: "RESOLVED" })])).toEqual({ action: "CREATE" });
    expect(decideFinding(finding(), [])).toEqual({ action: "CREATE" });
  });
});

describe("exception status machine and periods", () => {
  it("allows OPEN <-> ASSIGNED and resolving from either; RESOLVED is final", () => {
    expect(canTransitionException("OPEN", "ASSIGNED")).toBe(true);
    expect(canTransitionException("ASSIGNED", "OPEN")).toBe(true);
    expect(canTransitionException("ASSIGNED", "RESOLVED")).toBe(true);
    expect(canTransitionException("OPEN", "RESOLVED")).toBe(true);
    expect(canTransitionException("RESOLVED", "OPEN")).toBe(false);
    expect(canTransitionException("RESOLVED", "ASSIGNED")).toBe(false);
  });

  it("refuses empty and overlong periods", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    expect(periodProblem(start, start)).toBe("period_empty");
    expect(periodProblem(start, new Date("2027-11-01T00:00:00Z"))).toBe("period_too_long");
    expect(periodProblem(start, new Date("2026-11-01T00:00:00Z"))).toBeNull();
  });
});
