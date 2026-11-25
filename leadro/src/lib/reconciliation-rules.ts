/**
 * Reconciliation rules (spec 5.7, 13.3, 25.4). Pure: no database, no framework. The reconciliation service gathers the
 * facts (ledger balances, payments, outcomes, refunds, intake events) and asks these functions what they mean; it never
 * decides on its own.
 *
 * - `classifyJobBalance`: expected (billed) against recorded (net collected) money of one job in one currency.
 * - `classifyOutcomeCharge`: a SOLD outcome's reported charge against the CHARGE entries finance posted for it.
 * - `classifyRefund`: a refund that has no received payment behind it.
 * - `findingFingerprint` + `decideFinding`: what makes two findings "the same", so a re-run never duplicates an
 *   exception that is still open.
 * - The exception status machine: OPEN <-> ASSIGNED -> RESOLVED (the database trigger enforces the same list).
 */

export const RECONCILIATION_EXCEPTION_KINDS = [
  "UNPAID",
  "PARTIAL_PAYMENT",
  "OVERPAYMENT",
  "FAILED_PAYMENT",
  "DUPLICATE_EXTERNAL_EVENT",
  "OUTCOME_LEDGER_MISMATCH",
  "REFUND_WITHOUT_PAYMENT",
  "UNMATCHED_PROVIDER_EVENT",
  "OTHER",
] as const;
export type ReconciliationExceptionKindValue = (typeof RECONCILIATION_EXCEPTION_KINDS)[number];

export const RECONCILIATION_EXCEPTION_STATUSES = ["OPEN", "ASSIGNED", "RESOLVED"] as const;
export type ReconciliationExceptionStatusValue = (typeof RECONCILIATION_EXCEPTION_STATUSES)[number];

export const RECONCILIATION_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;

/**
 * Machine codes refining a kind (`details.code`). `OTHER` is only ever used with `finance_confirmation_pending`: a SOLD
 * outcome whose charge or collection finance has not confirmed yet (Task 4 made revenue finance-confirmed).
 */
export const RECONCILIATION_FINDING_CODES = [
  "finance_confirmation_pending",
  "refund_no_payment",
  "refund_payment_not_received",
  "refund_exceeds_payment",
] as const;
export type ReconciliationFindingCode = (typeof RECONCILIATION_FINDING_CODES)[number];

/** Why a run FAILED (`failureReason`): a machine code, never an internal message. */
export const RECONCILIATION_FAILURE_CODES = ["internal_error", "abandoned"] as const;

// ───────────── Exception status machine ─────────────

/** OPEN <-> ASSIGNED, either -> RESOLVED; RESOLVED is final (a recurring problem is a new exception). */
export const RECONCILIATION_EXCEPTION_TRANSITIONS: Readonly<Record<ReconciliationExceptionStatusValue, readonly ReconciliationExceptionStatusValue[]>> = {
  OPEN: ["ASSIGNED", "RESOLVED"],
  ASSIGNED: ["OPEN", "RESOLVED"],
  RESOLVED: [],
};

export function canTransitionException(from: ReconciliationExceptionStatusValue, to: ReconciliationExceptionStatusValue): boolean {
  return RECONCILIATION_EXCEPTION_TRANSITIONS[from].includes(to);
}

/** OPEN and ASSIGNED are the "unresolved" statuses: the work queue, and what a re-run must not duplicate. */
export const isUnresolvedException = (status: ReconciliationExceptionStatusValue): boolean => status !== "RESOLVED";

// ───────────── Expected vs recorded per job ─────────────

/**
 * The money gap of one job in one currency, or null when expected and recorded agree (or nothing is expected and nothing
 * was received). `billedMinor` = charged + adjustments; `netCollectedMinor` = payments - refunds - chargebacks (both from
 * `src/lib/ledger-balances.ts`).
 *
 * - UNPAID: something is billed and nothing (net) was received;
 * - PARTIAL_PAYMENT: less than billed was received;
 * - OVERPAYMENT: more than billed was received, including money received with nothing billed.
 * A negative net with nothing billed is a refund without payment: `classifyRefund` reports it per refund instead.
 */
export function classifyJobBalance(balance: { billedMinor: bigint; netCollectedMinor: bigint }): "UNPAID" | "PARTIAL_PAYMENT" | "OVERPAYMENT" | null {
  const { billedMinor, netCollectedMinor } = balance;
  if (netCollectedMinor > billedMinor && netCollectedMinor > 0n) return "OVERPAYMENT";
  if (billedMinor <= 0n) return null;
  if (netCollectedMinor <= 0n) return "UNPAID";
  if (netCollectedMinor < billedMinor) return "PARTIAL_PAYMENT";
  return null;
}

// ───────────── Outcome vs ledger ─────────────

/**
 * A SOLD outcome against what finance posted from it:
 * - MISMATCH: an active (not reversed) CHARGE exists and its total differs from the outcome's charged amount (the
 *   outcome was corrected after the charge was confirmed, or a charge exists for an outcome that now reports none);
 * - PENDING: the outcome reports a charge (or a collection) and finance has not confirmed it yet;
 * - null: they agree.
 */
export function classifyOutcomeCharge(input: {
  chargedAmountMinor: bigint | null;
  collectedAmountMinor: bigint | null;
  activeChargeMinors: bigint[];
  activeCollectionCount: number;
}): { kind: "MISMATCH"; postedMinor: bigint } | { kind: "PENDING"; chargePending: boolean; collectionPending: boolean } | null {
  const charged = input.chargedAmountMinor ?? 0n;
  const postedMinor = input.activeChargeMinors.reduce((sum, amount) => sum + amount, 0n);
  if (input.activeChargeMinors.length > 0 && postedMinor !== charged) return { kind: "MISMATCH", postedMinor };
  const chargePending = charged > 0n && input.activeChargeMinors.length === 0;
  const collectionPending = (input.collectedAmountMinor ?? 0n) > 0n && input.activeCollectionCount === 0;
  if (chargePending || collectionPending) return { kind: "PENDING", chargePending, collectionPending };
  return null;
}

// ───────────── Refunds ─────────────

/**
 * A refund (not rejected / cancelled) with no received money behind it, or null when it is covered:
 * - `refund_payment_not_received`: it names a payment that is not RECEIVED (pending, failed, voided);
 * - `refund_no_payment`: it names no payment and the job has no RECEIVED payment in its currency;
 * - `refund_exceeds_payment`: it names a received payment, but the live refunds of that payment add up to more than it.
 */
export function classifyRefund(input: {
  payment: { status: string; amountMinor: bigint; refundedMinor: bigint } | null;
  jobHasReceivedPayment: boolean;
}): ReconciliationFindingCode | null {
  if (input.payment) {
    if (input.payment.status !== "RECEIVED") return "refund_payment_not_received";
    return input.payment.refundedMinor > input.payment.amountMinor ? "refund_exceeds_payment" : null;
  }
  return input.jobHasReceivedPayment ? null : "refund_no_payment";
}

// ───────────── Findings and re-runs ─────────────

/** What a run found, before it is stored as an exception. */
export interface ReconciliationFinding {
  kind: ReconciliationExceptionKindValue;
  code: ReconciliationFindingCode | null;
  currency: string;
  jobId: string | null;
  paymentId: string | null;
  intakeEventId: string | null;
  refundId: string | null;
  outcomeId: string | null;
  orgUnitId: string | null;
  expectedAmountMinor: bigint | null;
  recordedAmountMinor: bigint | null;
}

type FingerprintFields = Pick<ReconciliationFinding, "kind" | "code" | "currency" | "jobId" | "paymentId" | "intakeEventId" | "refundId" | "outcomeId">;

/**
 * Identity of a finding: its kind, code and the records it is about, NOT its amounts. A job that is still partly paid
 * after another payment is the same problem, so it stays one exception.
 */
export function findingFingerprint(finding: FingerprintFields): string {
  return [finding.kind, finding.code ?? "", finding.currency, finding.jobId ?? "", finding.paymentId ?? "", finding.intakeEventId ?? "", finding.refundId ?? "", finding.outcomeId ?? ""].join("|");
}

export interface ExistingException extends FingerprintFields {
  id: string;
  status: ReconciliationExceptionStatusValue;
  expectedAmountMinor: bigint | null;
  recordedAmountMinor: bigint | null;
}

/**
 * What a run does with a finding, given the exceptions already recorded with the same fingerprint:
 * - ALREADY_OPEN: an unresolved one exists; nothing new is created (idempotent re-runs, spec 25.4);
 * - ACCEPTED: only resolved ones exist and one was resolved with exactly these amounts: a person looked at this very
 *   situation and closed it with a reason, so it is not raised again;
 * - CREATE: new, or the amounts moved since it was resolved.
 */
export function decideFinding(
  finding: ReconciliationFinding,
  existing: readonly ExistingException[],
): { action: "ALREADY_OPEN"; exceptionId: string } | { action: "ACCEPTED"; exceptionId: string } | { action: "CREATE" } {
  const open = existing.find((row) => isUnresolvedException(row.status));
  if (open) return { action: "ALREADY_OPEN", exceptionId: open.id };
  const accepted = existing.find(
    (row) => row.expectedAmountMinor === finding.expectedAmountMinor && row.recordedAmountMinor === finding.recordedAmountMinor,
  );
  if (accepted) return { action: "ACCEPTED", exceptionId: accepted.id };
  return { action: "CREATE" };
}

/** A period is `[periodStart, periodEnd)`; at most 366 days, so one synchronous run stays bounded. */
export const MAX_RECONCILIATION_PERIOD_DAYS = 366;

export function periodProblem(periodStart: Date, periodEnd: Date): "period_empty" | "period_too_long" | null {
  if (periodEnd.getTime() <= periodStart.getTime()) return "period_empty";
  if (periodEnd.getTime() - periodStart.getTime() > MAX_RECONCILIATION_PERIOD_DAYS * 86_400_000) return "period_too_long";
  return null;
}
