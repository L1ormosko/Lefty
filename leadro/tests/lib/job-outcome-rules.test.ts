import { describe, expect, it } from "vitest";
import { JOB_TRANSITIONS } from "@/lib/job-lifecycle";
import {
  JOB_OUTCOME_TYPES,
  NOT_CONVERTED_OUTCOMES,
  OUTCOME_REPORTABLE_STATUSES,
  OUTCOME_STATUS_RULES,
  outcomeProblem,
  outcomeTargetStatus,
} from "@/lib/job-outcome-rules";

describe("outcome > status mapping", () => {
  it("maps every outcome and only through direct edges of the status machine", () => {
    for (const outcome of JOB_OUTCOME_TYPES) {
      const rule = OUTCOME_STATUS_RULES[outcome];
      expect(rule.from.length).toBeGreaterThan(0);
      for (const from of rule.from) {
        expect(JOB_TRANSITIONS.some((edge) => edge.from === from && edge.to === rule.to), `${outcome}: ${from} > ${rule.to}`).toBe(true);
      }
    }
  });

  it("refuses an outcome from a status that does not allow it", () => {
    expect(outcomeTargetStatus("SOLD", "IN_PROGRESS")).toBe("COMPLETED");
    expect(outcomeTargetStatus("SOLD", "ARRIVED")).toBeNull(); // work has not started
    expect(outcomeTargetStatus("CUSTOMER_UNAVAILABLE", "EN_ROUTE")).toBe("CUSTOMER_UNAVAILABLE");
    expect(outcomeTargetStatus("RESCHEDULE_REQUIRED", "SCHEDULED")).toBeNull();
    expect(outcomeTargetStatus("WORK_NOT_POSSIBLE", "CLOSED")).toBeNull();
  });

  it("lists the statuses a visit can be finished from", () => {
    expect([...OUTCOME_REPORTABLE_STATUSES].sort()).toEqual(["ARRIVED", "EN_ROUTE", "IN_PROGRESS"]);
  });

  it("treats the reason-bearing unsuccessful outcomes as not converted", () => {
    expect([...NOT_CONVERTED_OUTCOMES]).toEqual(["NOT_SOLD", "WORK_NOT_POSSIBLE"]);
  });
});

describe("outcomeProblem", () => {
  it("requires a lost reason for NOT_SOLD and WORK_NOT_POSSIBLE", () => {
    expect(outcomeProblem({ outcome: "NOT_SOLD", hasLostReason: false })).toEqual({ code: "LOST_REASON_REQUIRED", field: "lostReasonId" });
    expect(outcomeProblem({ outcome: "WORK_NOT_POSSIBLE", hasLostReason: false })?.code).toBe("LOST_REASON_REQUIRED");
    expect(outcomeProblem({ outcome: "NOT_SOLD", hasLostReason: true, quotedAmountMinor: 5000 })).toBeNull();
  });

  it("forbids a lost reason on a sale", () => {
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: true })?.code).toBe("LOST_REASON_NOT_ALLOWED");
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: false })).toBeNull();
  });

  it("allows sale money and payment only on a sale", () => {
    expect(outcomeProblem({ outcome: "NOT_SOLD", hasLostReason: true, chargedAmountMinor: 1 })?.code).toBe("AMOUNTS_NOT_APPLICABLE");
    expect(outcomeProblem({ outcome: "CUSTOMER_UNAVAILABLE", hasLostReason: false, paymentMethod: "CASH" })?.code).toBe("PAYMENT_NOT_APPLICABLE");
    expect(outcomeProblem({ outcome: "CUSTOMER_UNAVAILABLE", hasLostReason: false, quotedAmountMinor: 100 })).toBeNull();
  });

  it("needs a collected amount and a method once a payment is partial or paid", () => {
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: false, paymentStatus: "PAID" })?.code).toBe("PAYMENT_NEEDS_COLLECTED_AMOUNT");
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: false, paymentStatus: "PAID", collectedAmountMinor: 100 })?.code).toBe("PAYMENT_NEEDS_COLLECTED_AMOUNT");
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: false, paymentStatus: "PAID", collectedAmountMinor: 100, paymentMethod: "CARD", chargedAmountMinor: 100 })).toBeNull();
    expect(outcomeProblem({ outcome: "SOLD", hasLostReason: false, paymentStatus: "PENDING", chargedAmountMinor: 100 })).toBeNull();
  });
});
