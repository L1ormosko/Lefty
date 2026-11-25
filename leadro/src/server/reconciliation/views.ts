import type { Prisma, ReconciliationException, ReconciliationRun } from "@prisma/client";

/**
 * Response shapes of the reconciliation API. Ids, money, enums and codes only: no job titles, addresses or customer
 * names (finance sees a job only through its `financial` set, spec 22.2).
 *
 * Outcome money is redacted per row: OUTCOME_LEDGER_MISMATCH and finance-confirmation exceptions carry the amount the
 * technician reported, which is the `financial` set of `job_outcomes` (Task 4's one rule for outcome money). A viewer
 * without that set over the exception's unit gets `moneyRedacted: true` and no amounts.
 */

export interface RunView {
  id: string;
  legalEntityId: string | null;
  /** TENANT: the run covered every legal entity (and jobs whose unit has none). */
  coverage: "TENANT" | "LEGAL_ENTITY";
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  status: ReconciliationRun["status"];
  jobsExamined: number;
  /** Findings of this run: new exceptions plus ones still open from earlier runs. */
  exceptionCount: number;
  /** Sum of what the examined jobs are billed (charged + adjustments). */
  expectedMinor: bigint;
  /** Sum of what was net collected on them (payments - refunds - chargebacks). */
  recordedMinor: bigint;
  differenceMinor: bigint;
  startedById: string | null;
  startedAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

export function toRunView(run: ReconciliationRun): RunView {
  return {
    id: run.id,
    legalEntityId: run.legalEntityId,
    coverage: run.legalEntityId ? "LEGAL_ENTITY" : "TENANT",
    currency: run.currency,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: run.status,
    jobsExamined: run.jobsExamined,
    exceptionCount: run.exceptionCount,
    expectedMinor: run.expectedMinor,
    recordedMinor: run.recordedMinor,
    differenceMinor: run.expectedMinor - run.recordedMinor,
    startedById: run.startedById,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    failureReason: run.failureReason,
  };
}

/** Keys of `details` that hold money (decimal strings): hidden together with the amount columns when redacted. */
const MONEY_DETAIL_KEYS = ["latestExpectedMinor", "latestRecordedMinor", "refundedMinor", "paymentAmountMinor"];

/** Kinds whose amounts come from a visit outcome (the technician's report). */
export const isOutcomeMoney = (exception: Pick<ReconciliationException, "kind" | "outcomeId">): boolean =>
  exception.outcomeId !== null && (exception.kind === "OUTCOME_LEDGER_MISMATCH" || exception.kind === "OTHER");

export interface ExceptionView {
  id: string;
  runId: string;
  kind: ReconciliationException["kind"];
  /** Refines the kind (`RECONCILIATION_FINDING_CODES`), e.g. `finance_confirmation_pending`; null when the kind says it all. */
  code: string | null;
  status: ReconciliationException["status"];
  currency: string;
  jobId: string | null;
  paymentId: string | null;
  intakeEventId: string | null;
  refundId: string | null;
  outcomeId: string | null;
  orgUnitId: string | null;
  /** What was found when the exception was raised (frozen). */
  expectedAmountMinor: bigint | null;
  recordedAmountMinor: bigint | null;
  /** True when the amounts are outcome money the viewer may not see. */
  moneyRedacted: boolean;
  /** The last run that found this problem again, with what it saw then; ids, codes and numbers only. */
  details: Record<string, unknown>;
  assignedToId: string | null;
  assignedAt: Date | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const detailsOf = (value: Prisma.JsonValue | null): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

export function toExceptionView(exception: ReconciliationException, canSeeOutcomeMoney: boolean): ExceptionView {
  const details = detailsOf(exception.details);
  const moneyRedacted = isOutcomeMoney(exception) && !canSeeOutcomeMoney;
  if (moneyRedacted) for (const key of MONEY_DETAIL_KEYS) delete details[key];
  return {
    id: exception.id,
    runId: exception.runId,
    kind: exception.kind,
    code: typeof details.code === "string" ? details.code : null,
    status: exception.status,
    currency: exception.currency,
    jobId: exception.jobId,
    paymentId: exception.paymentId,
    intakeEventId: exception.intakeEventId,
    refundId: exception.refundId,
    outcomeId: exception.outcomeId,
    orgUnitId: exception.orgUnitId,
    expectedAmountMinor: moneyRedacted ? null : exception.expectedAmountMinor,
    recordedAmountMinor: moneyRedacted ? null : exception.recordedAmountMinor,
    moneyRedacted,
    details,
    assignedToId: exception.assignedToId,
    assignedAt: exception.assignedAt,
    resolvedById: exception.resolvedById,
    resolvedAt: exception.resolvedAt,
    resolutionReason: exception.resolutionReason,
    createdAt: exception.createdAt,
    updatedAt: exception.updatedAt,
  };
}
