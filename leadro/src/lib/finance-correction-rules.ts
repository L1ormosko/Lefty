/**
 * Pure rules of refunds, chargebacks, adjustments and finance review flags (spec 11.7, 25.4). No Prisma, no Next.
 *
 * The status machines themselves are the database's (`refund_status`, `chargeback_status`, `adjustment_status`,
 * `finance_review_flag_status` triggers, migration 20261124100000 / 20261125100000); the lists below mirror them so the
 * services can answer a clean 409 before the trigger would refuse the statement.
 */

export type RefundStatusValue = "REQUESTED" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "POSTED" | "CANCELLED";
export type ChargebackStatusValue = "OPEN" | "DISPUTED" | "WON" | "LOST" | "WRITE_OFF_PENDING_APPROVAL" | "WRITTEN_OFF";
export type AdjustmentStatusValue = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "POSTED" | "CANCELLED";

/** Refunds that still hold (or have spent) part of a payment: everything but REJECTED and CANCELLED. */
export const REFUND_STATUSES_HOLDING_PAYMENT: readonly RefundStatusValue[] = ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "POSTED"];
/** Refunds that can still be cancelled (nothing was paid out yet). */
export const CANCELLABLE_REFUND_STATUSES: readonly RefundStatusValue[] = ["REQUESTED", "PENDING_APPROVAL", "APPROVED"];
/** Chargebacks whose money is (or stays) with the customer: everything but WON. */
export const CHARGEBACK_STATUSES_HOLDING_PAYMENT: readonly ChargebackStatusValue[] = ["OPEN", "DISPUTED", "LOST", "WRITE_OFF_PENDING_APPROVAL", "WRITTEN_OFF"];

/** The DB machine of chargebacks (`chargeback_status` trigger), for clean 409s. */
export const CHARGEBACK_TRANSITIONS: ReadonlyArray<readonly [ChargebackStatusValue, ChargebackStatusValue]> = [
  ["OPEN", "DISPUTED"],
  ["OPEN", "WON"],
  ["OPEN", "LOST"],
  ["DISPUTED", "WON"],
  ["DISPUTED", "LOST"],
  ["LOST", "WRITE_OFF_PENDING_APPROVAL"],
  ["LOST", "WRITTEN_OFF"],
  ["WRITE_OFF_PENDING_APPROVAL", "WRITTEN_OFF"],
  ["WRITE_OFF_PENDING_APPROVAL", "LOST"],
];

export const chargebackTransitionAllowed = (from: ChargebackStatusValue, to: ChargebackStatusValue): boolean =>
  CHARGEBACK_TRANSITIONS.some(([a, b]) => a === from && b === to);

/**
 * How much of a received payment can still be refunded or charged back: its amount minus every refund that holds part of
 * it and every chargeback not won. Never negative in a consistent ledger; callers refuse an amount above it.
 */
export function remainingOnPayment(paymentAmountMinor: bigint, heldByRefundsMinor: bigint, heldByChargebacksMinor: bigint): bigint {
  return paymentAmountMinor - heldByRefundsMinor - heldByChargebacksMinor;
}

/**
 * Why an adjustment is made (the `reasonCode` people choose; free text goes in `reason`). Deliberately NOTHING about
 * employees: an adjustment corrects what a CUSTOMER owes on a job. It never deducts from wages or touches commission
 * (spec 11.7: no automatic wage deduction without legal review and an approved policy; compensation is blocked on the
 * owner's specification, spec 28.4).
 */
export const ADJUSTMENT_REASON_CODES = [
  "billing_correction",
  "goodwill_credit",
  "price_change",
  "job_reopened",
  "outcome_corrected",
  "other",
] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

/** The reason code of the system's own adjustment when a lost chargeback is written off (never chosen by a person). */
export const CHARGEBACK_WRITE_OFF_REASON_CODE = "chargeback_write_off";

/**
 * Is this job status change a REOPENING of work (spec 25.4 "job is reopened")? True when finished work goes back into
 * progress: a reviewer sends it back (AWAITING_REVIEW > IN_PROGRESS), a completed or failed visit needs a return visit,
 * or the next visit of a job whose previous visit already has an outcome starts. Money already posted for the job is then
 * flagged for finance review: finance corrects it with an adjustment, never by editing what was posted.
 */
export function isJobReopening(from: string, to: string, startedNextVisit: boolean): boolean {
  if (startedNextVisit) return true;
  if (from === "AWAITING_REVIEW" && to === "IN_PROGRESS") return true;
  return (from === "COMPLETED" || from === "FAILED") && to === "REQUIRES_RETURN_VISIT";
}

/** Machine reason codes of finance review flags (lowercase dotted: DB CHECK `finance_review_flag_reason_code_format`). */
export const REVIEW_FLAG_REASONS = {
  /** A job with ledger entries went back into work. */
  jobReopened: "job.reopened_after_posting",
  /** An outcome whose charge or collection was posted was corrected. */
  outcomeCorrected: "outcome.corrected_after_posting",
  /** A refund was paid out: any compensation that counted the money needs a person's review (no automatic effect). */
  refundPosted: "refund.posted",
  /** A chargeback was opened (provider or manual). */
  chargebackOpened: "chargeback.opened",
  /** A costed material line could not be posted to the ledger (cost currency differs from the job's). */
  materialCostCurrencyMismatch: "material_cost.currency_mismatch",
  /** Raised by a person. */
  manual: "manual.review_requested",
} as const;
