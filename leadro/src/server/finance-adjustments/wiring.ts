import { isJobReopening, REVIEW_FLAG_REASONS } from "@/lib/finance-correction-rules";
import { registerApprovalSubject } from "@/server/approvals";
import { JOB_OUTCOME_FIELD_MAP } from "@/server/authz";
import type { TenantTx } from "@/server/db";
import { onJobOutcomeCorrected, type OutcomeCorrectedEvent } from "@/server/job-outcomes";
import { onJobStatusChanged, type JobStatusChangedEvent } from "@/server/jobs";
import { loadFinanceJob, onLedgerCorrection, type LedgerCorrectionEvent } from "@/server/ledger";
import { adjustmentResourceRef, onAdjustmentApproved, onAdjustmentRejected } from "./adjustments";
import { registerChargebackIntake } from "./chargeback-intake";
import { chargebackResourceRef, onWriteOffApproved, onWriteOffRejected } from "./chargebacks";
import { FINANCE_REVIEW_SYSTEM_ACTOR } from "./common";
import { ADJUSTMENT_SUBJECT, CHARGEBACK_WRITE_OFF_SUBJECT, REFUND_SUBJECT, reviewFlagKeys } from "./keys";
import { onRefundApproved, onRefundRejected, refundResourceRef } from "./refunds";
import { raiseFinanceReviewFlagInTx } from "./review-flags";

/**
 * How this module plugs into the rest of the platform. Every function is idempotent; `registerFinanceAdjustments()` runs
 * at module load AND from `src/server/notification-targets.ts` (Next.js bundles instrumentation and routes separately).
 */

/** REFUND, ADJUSTMENT and CHARGEBACK_WRITE_OFF with the approval engine. Request scope = the job's current unit. */
export function registerFinanceApprovalSubjects(): void {
  registerApprovalSubject(REFUND_SUBJECT, { resolveResource: refundResourceRef, onApproved: onRefundApproved, onRejected: onRefundRejected });
  registerApprovalSubject(ADJUSTMENT_SUBJECT, { resolveResource: adjustmentResourceRef, onApproved: onAdjustmentApproved, onRejected: onAdjustmentRejected });
  registerApprovalSubject(CHARGEBACK_WRITE_OFF_SUBJECT, { resolveResource: chargebackResourceRef, onApproved: onWriteOffApproved, onRejected: onWriteOffRejected });
}

/** The outcome fields whose correction can make posted money wrong: its `financial` field set (one definition, authz). */
const OUTCOME_MONEY_FIELDS: readonly string[] = Object.entries(JOB_OUTCOME_FIELD_MAP)
  .filter(([, tag]) => tag === "financial")
  .map(([field]) => field);

/** Revenue-side money of a job: anything but its material cost (a reopened job with only costed materials needs no review). */
async function jobHasPostedMoney(tx: TenantTx, tenantId: string, where: { jobId: string } | { outcomeId: string }): Promise<boolean> {
  return (await tx.ledgerEntry.count({ where: { tenantId, ...where, type: { not: "MATERIAL_COST" } } })) > 0;
}

/**
 * Spec 25.4 "job is reopened": when finished work goes back into progress and money was already posted for the job, finance
 * is asked to review it (flag `job.reopened_after_posting`, one per status change). The posted entries stay as they are;
 * any change to what the customer owes is an adjustment.
 */
export async function flagReopenedJob(tx: TenantTx, event: JobStatusChangedEvent): Promise<void> {
  if (!isJobReopening(event.from, event.to, event.startedNextVisit)) return;
  if (!(await jobHasPostedMoney(tx, event.tenantId, { jobId: event.jobId }))) return;
  const job = await loadFinanceJob(tx, event.tenantId, event.jobId);
  if (!job) return;
  await raiseFinanceReviewFlagInTx(tx, {
    tenantId: event.tenantId,
    reasonCode: REVIEW_FLAG_REASONS.jobReopened,
    idempotencyKey: reviewFlagKeys.jobReopened(event.statusHistoryId),
    refs: { jobId: job.id, customerId: job.customerId },
    orgUnitId: job.orgUnitId,
    details: { fromStatus: event.from, toStatus: event.to, statusHistoryId: event.statusHistoryId, startedNextVisit: event.startedNextVisit, reopenedById: event.actorUserId },
    raisedBy: { system: FINANCE_REVIEW_SYSTEM_ACTOR },
    ctx: null,
  });
}

/** An outcome whose charge or collection was posted had its money corrected: flag it (one flag per correction). */
export async function flagCorrectedOutcome(tx: TenantTx, event: OutcomeCorrectedEvent): Promise<void> {
  if (!event.changedFields.some((field) => OUTCOME_MONEY_FIELDS.includes(field))) return;
  if (!(await jobHasPostedMoney(tx, event.tenantId, { outcomeId: event.outcomeId }))) return;
  const job = await loadFinanceJob(tx, event.tenantId, event.jobId);
  if (!job) return;
  await raiseFinanceReviewFlagInTx(tx, {
    tenantId: event.tenantId,
    reasonCode: REVIEW_FLAG_REASONS.outcomeCorrected,
    idempotencyKey: reviewFlagKeys.outcomeCorrected(event.jobEventId),
    refs: { jobId: job.id, customerId: job.customerId, outcomeId: event.outcomeId },
    orgUnitId: job.orgUnitId,
    details: { jobEventId: event.jobEventId, changedFields: event.changedFields.filter((field) => OUTCOME_MONEY_FIELDS.includes(field)).sort().join(","), correctedById: event.actorUserId },
    raisedBy: { system: FINANCE_REVIEW_SYSTEM_ACTOR },
    ctx: null,
  });
}

/**
 * A CHARGE reversal or the void of a RECEIVED payment took money out of the books with no approval behind it (one person,
 * `finance_payments.edit`): flag it so a second finance person reviews it (spec 21.3, 11.7; review P4-R2). One flag per
 * correction (keyed by its REVERSAL entry). Whether these corrections should need an approval is an owner decision.
 */
export async function flagLedgerCorrection(tx: TenantTx, event: LedgerCorrectionEvent): Promise<void> {
  await raiseFinanceReviewFlagInTx(tx, {
    tenantId: event.tenantId,
    reasonCode: event.kind === "CHARGE_REVERSED" ? REVIEW_FLAG_REASONS.chargeReversed : REVIEW_FLAG_REASONS.paymentVoided,
    idempotencyKey: reviewFlagKeys.ledgerCorrection(event.reversalEntryId),
    refs: { jobId: event.jobId, customerId: event.customerId, outcomeId: event.outcomeId, paymentId: event.paymentId, ledgerEntryId: event.reversalEntryId },
    orgUnitId: event.orgUnitId,
    details: { originalEntryId: event.originalEntryId, amountMinor: event.amountMinor, currency: event.currency, correctedById: event.actorUserId },
    raisedBy: { system: FINANCE_REVIEW_SYSTEM_ACTOR },
    ctx: null,
  });
}

/** Everything at once: approval subjects, the provider chargeback intake and the three domain reactions. */
export function registerFinanceAdjustments(): void {
  registerFinanceApprovalSubjects();
  registerChargebackIntake();
  onJobStatusChanged("finance-review.job-reopened", flagReopenedJob);
  onJobOutcomeCorrected("finance-review.outcome-corrected", flagCorrectedOutcome);
  onLedgerCorrection("finance-review.ledger-correction", flagLedgerCorrection);
}
