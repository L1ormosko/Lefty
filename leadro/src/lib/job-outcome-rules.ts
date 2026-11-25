import type { JobStatusValue } from "./job-lifecycle";

/**
 * Pure rules of visit outcome reporting (§9.1, §9.2): which job status each outcome leads to, which
 * outcomes need a lost reason, and which carry money. The jobs service applies the status change
 * through its lifecycle machine; this file only says what should happen.
 */
export const JOB_OUTCOME_TYPES = [
  "SOLD",
  "NOT_SOLD",
  "CUSTOMER_UNAVAILABLE",
  "RESCHEDULE_REQUIRED",
  "WORK_NOT_POSSIBLE",
  "ADDITIONAL_APPROVAL_REQUIRED",
] as const;
export type JobOutcomeTypeValue = (typeof JOB_OUTCOME_TYPES)[number];

/**
 * Outcome > the job status it produces, and the statuses it may be reported from. Every pair is a
 * DIRECT edge of the status machine (`JOB_TRANSITIONS`; a test pins that), so recording an outcome
 * never invents a transition and never fabricates a milestone: SOLD / NOT_SOLD need the work to have
 * started (IN_PROGRESS), exactly as the default path requires.
 *
 *  - SOLD, NOT_SOLD       > COMPLETED (the visit is done; NOT_SOLD is an unsuccessful but finished visit)
 *  - ADDITIONAL_APPROVAL_REQUIRED > REQUIRES_RETURN_VISIT (someone must approve more work, then a new visit)
 *  - WORK_NOT_POSSIBLE    > FAILED
 *  - CUSTOMER_UNAVAILABLE > CUSTOMER_UNAVAILABLE
 *  - RESCHEDULE_REQUIRED  > RESCHEDULED
 */
export const OUTCOME_STATUS_RULES: Record<JobOutcomeTypeValue, { from: readonly JobStatusValue[]; to: JobStatusValue }> = {
  SOLD: { from: ["IN_PROGRESS"], to: "COMPLETED" },
  NOT_SOLD: { from: ["IN_PROGRESS"], to: "COMPLETED" },
  ADDITIONAL_APPROVAL_REQUIRED: { from: ["IN_PROGRESS"], to: "REQUIRES_RETURN_VISIT" },
  WORK_NOT_POSSIBLE: { from: ["ARRIVED", "IN_PROGRESS"], to: "FAILED" },
  CUSTOMER_UNAVAILABLE: { from: ["EN_ROUTE", "ARRIVED"], to: "CUSTOMER_UNAVAILABLE" },
  RESCHEDULE_REQUIRED: { from: ["EN_ROUTE", "ARRIVED"], to: "RESCHEDULED" },
};

/** The job status an outcome leads to when reported from `current`, or null when it cannot be reported from there. */
export function outcomeTargetStatus(outcome: JobOutcomeTypeValue, current: JobStatusValue): JobStatusValue | null {
  const rule = OUTCOME_STATUS_RULES[outcome];
  return rule.from.includes(current) ? rule.to : null;
}

/** Statuses from which SOME outcome can be reported (what the technician's "finish visit" action is offered in). */
export const OUTCOME_REPORTABLE_STATUSES: readonly JobStatusValue[] = [
  ...new Set(Object.values(OUTCOME_STATUS_RULES).flatMap((rule) => rule.from)),
];

/**
 * A job moved past its visit by hand (a dispatcher completed or failed it, a reviewer holds it) has no outcome and could never
 * close (§9.1). In these statuses an outcome may be recorded RETROACTIVELY: it is stored and audited as such and the job status
 * does not change (it already is where it should be). Only while the current visit still has no outcome.
 */
export const RETROACTIVE_OUTCOME_STATUSES: readonly JobStatusValue[] = ["COMPLETED", "FAILED", "REQUIRES_RETURN_VISIT", "AWAITING_REVIEW", "CUSTOMER_UNAVAILABLE"];

/** Statuses that open a new visit when the previous visit already has its outcome (the technician is on the way again). */
export const VISIT_START_STATUSES: readonly JobStatusValue[] = ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"];

/** §9.1: an unsuccessful outcome needs a lost reason. */
export const OUTCOMES_REQUIRING_LOST_REASON: readonly JobOutcomeTypeValue[] = ["NOT_SOLD", "WORK_NOT_POSSIBLE"];
/** A successful sale has no lost reason (the database agrees). */
export const OUTCOMES_FORBIDDING_LOST_REASON: readonly JobOutcomeTypeValue[] = ["SOLD"];
/** Outcomes the recovery engine treats as "not converted" (`job.not_converted`, §9.3). */
export const NOT_CONVERTED_OUTCOMES: readonly JobOutcomeTypeValue[] = ["NOT_SOLD", "WORK_NOT_POSSIBLE"];

/** Only a sale carries approved / charged / collected money and a payment; every other outcome may carry the quote. */
export const OUTCOMES_WITH_PAYMENT: readonly JobOutcomeTypeValue[] = ["SOLD"];

export interface OutcomeFacts {
  outcome: JobOutcomeTypeValue;
  hasLostReason: boolean;
  quotedAmountMinor?: bigint | null;
  approvedAmountMinor?: bigint | null;
  chargedAmountMinor?: bigint | null;
  collectedAmountMinor?: bigint | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
}

/** A refusal named by a stable code plus the offending field (clients translate by code, never by text). */
export interface OutcomeProblem {
  code: "LOST_REASON_REQUIRED" | "LOST_REASON_NOT_ALLOWED" | "AMOUNTS_NOT_APPLICABLE" | "PAYMENT_NOT_APPLICABLE" | "PAYMENT_NEEDS_COLLECTED_AMOUNT";
  field: string;
}

/** Cross-field rules of an outcome record; null when it is consistent. The first problem wins. */
export function outcomeProblem(facts: OutcomeFacts): OutcomeProblem | null {
  if (OUTCOMES_REQUIRING_LOST_REASON.includes(facts.outcome) && !facts.hasLostReason) return { code: "LOST_REASON_REQUIRED", field: "lostReasonId" };
  if (OUTCOMES_FORBIDDING_LOST_REASON.includes(facts.outcome) && facts.hasLostReason) return { code: "LOST_REASON_NOT_ALLOWED", field: "lostReasonId" };
  const paysOutcome = OUTCOMES_WITH_PAYMENT.includes(facts.outcome);
  const hasSaleMoney = [facts.approvedAmountMinor, facts.chargedAmountMinor, facts.collectedAmountMinor].some((value) => value !== null && value !== undefined);
  if (!paysOutcome && hasSaleMoney) return { code: "AMOUNTS_NOT_APPLICABLE", field: "approvedAmountMinor" };
  const hasPayment = Boolean(facts.paymentMethod) || (facts.paymentStatus !== undefined && facts.paymentStatus !== null && facts.paymentStatus !== "NOT_APPLICABLE");
  if (!paysOutcome && hasPayment) return { code: "PAYMENT_NOT_APPLICABLE", field: "paymentStatus" };
  const collectedStatus = facts.paymentStatus === "PARTIAL" || facts.paymentStatus === "PAID";
  if (collectedStatus && (facts.collectedAmountMinor === null || facts.collectedAmountMinor === undefined || !facts.paymentMethod)) {
    return { code: "PAYMENT_NEEDS_COLLECTED_AMOUNT", field: "collectedAmountMinor" };
  }
  return null;
}
