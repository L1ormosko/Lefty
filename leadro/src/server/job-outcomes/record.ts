import { canStillReach } from "@/lib/job-lifecycle";
import { hashFieldEventContent } from "@/lib/location-rules";
import { NOT_CONVERTED_OUTCOMES, RETROACTIVE_OUTCOME_STATUSES, outcomeProblem, outcomeTargetStatus, type JobOutcomeTypeValue } from "@/lib/job-outcome-rules";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { canInTx, enforceInTx, projectFields, type AccessDecision, type ResourceRef } from "@/server/authz";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  conflictOnUniqueViolation,
  type Actor,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { runFieldEvent } from "@/server/field-events";
import { changeJobStatus, jobResourceRef, loadJobForChange, recordJobEvent } from "@/server/jobs";
import { deliverAfterCommit } from "@/server/notifications";
import { OUTCOME_FIELD_MAP, OUTCOME_FINANCIAL_KEYS, outcomeRowSelect, type OutcomeRow } from "./fields";
import { publishOutcomeRecorded } from "./events";
import { decisionHoldsFinancial } from "./financial";
import { notifyNotConverted } from "./notify";
import type { RecordOutcomeInput } from "./schemas";

/**
 * Recording the outcome of a visit (§9.1). One outcome per `(job, visitNumber)`; recording it also moves the
 * job along the lifecycle (`OUTCOME_STATUS_RULES`), writes the job's events (`job.outcome_recorded`, plus
 * `job.not_converted` for unsuccessful visits), an audit row, tells the managers about a lost visit and
 * publishes the domain event the recovery engine subscribes to. All of it is one transaction.
 *
 * A job already past its visit (completed or failed by hand, awaiting review...) takes a RETROACTIVE outcome:
 * same record, audited as retroactive, no status change; otherwise such a job could never close.
 */

/** How far into the future a device clock may be before `occurredAt` is refused (clock drift, not a time machine). */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface RecordedOutcome {
  outcome: Record<string, unknown>;
  job: { id: string; status: string; currentVisitNumber: number };
  /** True when this call returned the result of an earlier identical submission (offline replay). */
  replayed: boolean;
}

export interface RecordOutcomeInTxResult {
  outcomeId: string;
  replayed: boolean;
  /** Stored after the fact (the job was already past its visit): the job status did not change. */
  retroactive: boolean;
  /** The caller's `job_outcomes` decision over the job: which field sets a response may show. */
  decision: AccessDecision;
  notificationIds: string[];
}

const refusal = (field: string, code: string, message: string, retryable = false): ValidationError =>
  new ValidationError({ message, field, retryable, details: [{ field, code, message }] });

/** The lost reason must exist, be active and apply to the outcome. */
async function checkLostReason(tx: TenantTx, tenantId: string, lostReasonId: string, outcome: JobOutcomeTypeValue): Promise<{ id: string; code: string; recoverable: boolean }> {
  const reason = await tx.lostReason.findFirst({ where: { id: lostReasonId, tenantId }, select: { id: true, code: true, recoverable: true, active: true, appliesTo: true } });
  if (!reason || !reason.active) throw refusal("lostReasonId", "job_outcome.lost_reason_unknown", "Choose an active lost reason.");
  if (!reason.appliesTo.includes(outcome)) throw refusal("lostReasonId", "job_outcome.lost_reason_not_applicable", "This lost reason does not apply to the chosen outcome.");
  return reason;
}

/** Throws the validation error for a cross-field problem of the outcome (reason / money / payment rules). */
function assertConsistent(input: RecordOutcomeInput): void {
  const problem = outcomeProblem({
    outcome: input.outcome,
    hasLostReason: input.lostReasonId !== undefined,
    quotedAmountMinor: input.quotedAmountMinor,
    approvedAmountMinor: input.approvedAmountMinor,
    chargedAmountMinor: input.chargedAmountMinor,
    collectedAmountMinor: input.collectedAmountMinor,
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentStatus,
  });
  if (problem) throw refusal(problem.field, `job_outcome.${problem.code.toLowerCase()}`, `Invalid outcome: ${problem.code}.`);
}

/**
 * Who may record: `job_outcomes.create` over the job (the technician, tenant-wide Owner / COO). Holders of only
 * `job_outcomes.edit` (managers) may record a RETROACTIVE outcome, so a hand-moved job can still close; `mayCreate`
 * tells the caller which of the two it got. Throws the usual 403 / 404 when neither is held.
 */
async function authorizeRecording(tx: TenantTx, actor: Actor, resource: ResourceRef): Promise<{ decision: AccessDecision; mayCreate: boolean }> {
  const create = await canInTx(tx, actor, "job_outcomes.create", resource);
  if (create.allowed) return { decision: create, mayCreate: true };
  const edit = await canInTx(tx, actor, "job_outcomes.edit", resource);
  if (edit.allowed) return { decision: edit, mayCreate: false };
  await enforceInTx(tx, actor, "job_outcomes.create", resource); // throws, and audits the denial
  throw new ForbiddenError();
}

/** Sending money or payment needs the `financial` field set (like `jobs.financial_fields`). */
function assertMayWriteMoney(decision: AccessDecision, input: RecordOutcomeInput): void {
  const sent = Object.entries(input)
    .filter(([key, value]) => value !== undefined && OUTCOME_FINANCIAL_KEYS.includes(key))
    .map(([key]) => key);
  if (sent.length > 0 && !decisionHoldsFinancial(decision)) {
    throw new ForbiddenError({ message: "Your access does not include outcome amounts or payment.", field: sent[0] });
  }
}

/**
 * The domain work of recording an outcome, inside the caller's transaction (the API and the offline
 * sync both call it). The caller has NOT locked anything: this locks the job first. Authorization is
 * `job_outcomes.create` over the job (`edit` alone suffices for a retroactive outcome).
 *
 * Replays: when `input.clientEventId` already recorded an outcome for this job, that outcome is returned
 * (`replayed: true`) and nothing is written. A second, different outcome for the same visit is a 409.
 *
 * @returns the outcome id, flags, the caller's decision (for projecting the response) and the notification ids to deliver after commit.
 */
export async function recordOutcomeInTx(tx: TenantTx, actor: Actor, audit: AuditContextFields, jobId: string, input: RecordOutcomeInput): Promise<RecordOutcomeInTxResult> {
  const tenantId = actor.tenantId;
  const job = await loadJobForChange(tx, tenantId, jobId); // locks the row: concurrent submissions queue up here
  const resource = await jobResourceRef(tx, tenantId, jobId);
  if (!resource) throw new NotFoundError();
  const { decision, mayCreate } = await authorizeRecording(tx, actor, resource);
  assertMayWriteMoney(decision, input);

  if (input.clientEventId) {
    const replay = await tx.jobOutcome.findFirst({ where: { tenantId, jobId, clientEventId: input.clientEventId }, select: { id: true } });
    if (replay) return { outcomeId: replay.id, replayed: true, retroactive: false, decision, notificationIds: [] };
  }
  const jobFacts = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId }, select: { currency: true, number: true, createdAt: true } });
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) throw refusal("occurredAt", "job_outcome.occurred_in_future", "The time of the outcome cannot be in the future.");
  // The outcome cannot predate the visit it reports: the work start when there was one, else the job itself.
  const earliest = job.startedAt ?? jobFacts.createdAt;
  if (occurredAt.getTime() < earliest.getTime()) throw refusal("occurredAt", "job_outcome.occurred_too_early", "The time of the outcome cannot be before the visit started.", true);
  if (input.currency && input.currency !== jobFacts.currency) throw refusal("currency", "job_outcome.currency_mismatch", "The outcome currency must be the job's currency.");

  const existing = await tx.jobOutcome.findFirst({ where: { tenantId, jobId, visitNumber: job.currentVisitNumber }, select: { id: true } });
  if (existing) {
    throw new ConflictError({
      message: "An outcome was already recorded for this visit.",
      details: [{ field: "outcome", code: "job_outcome.already_recorded", message: "An outcome was already recorded for this visit." }],
    });
  }
  const normalTarget = outcomeTargetStatus(input.outcome, job.status);
  const retroactive = normalTarget === null && RETROACTIVE_OUTCOME_STATUSES.includes(job.status);
  if (!normalTarget && !retroactive) {
    // Retryable while the job can still advance (its start-work event may not have synced yet); never stored then.
    throw new InvalidStateTransitionError({
      retryable: canStillReach(job.status, "IN_PROGRESS"),
      message: `The outcome ${input.outcome} cannot be reported while the job is ${job.status}.`,
      details: [{ field: "outcome", code: "job_outcome.not_reportable", message: `The outcome ${input.outcome} cannot be reported while the job is ${job.status}.` }],
    });
  }
  // Edit-only holders (managers) record after the fact; reporting a live visit is the technician's / `create` holder's act.
  if (normalTarget && !mayCreate) throw new ForbiddenError({ message: "Only the person who works the visit can report its outcome." });

  assertConsistent(input);
  const lostReason = input.lostReasonId ? await checkLostReason(tx, tenantId, input.lostReasonId, input.outcome) : null;

  const created = await tx.jobOutcome.create({
    data: {
      tenantId,
      jobId,
      visitNumber: job.currentVisitNumber,
      employeeId: actor.employeeId,
      outcome: input.outcome,
      lostReasonId: lostReason?.id ?? null,
      notes: input.notes ?? null,
      quotedAmountMinor: input.quotedAmountMinor ?? null,
      approvedAmountMinor: input.approvedAmountMinor ?? null,
      chargedAmountMinor: input.chargedAmountMinor ?? null,
      collectedAmountMinor: input.collectedAmountMinor ?? null,
      currency: jobFacts.currency,
      paymentMethod: input.paymentMethod ?? null,
      paymentStatus: input.paymentStatus ?? "NOT_APPLICABLE",
      customerRequestedFollowUp: input.customerRequestedFollowUp ?? false,
      preferredFollowUpAt: input.preferredFollowUpAt ?? null,
      occurredAt,
      recordedById: actor.userId,
      clientEventId: input.clientEventId ?? null,
    },
    select: { id: true },
  });

  // The job follows the outcome through its own lifecycle (guards, tenant narrowing, history); the status reason names the outcome, not free text.
  // Retroactive: the job is already where it should be (or a reviewer holds it); only the missing record is added.
  const statusReason = `Outcome ${input.outcome}${lostReason ? ` (${lostReason.code})` : ""}`;
  const change = normalTarget ? await changeJobStatus(tx, actor, audit, job, normalTarget, { reason: statusReason }) : { from: job.status, to: job.status };

  const notConverted = NOT_CONVERTED_OUTCOMES.includes(input.outcome);
  const customerRequestedFollowUp = input.customerRequestedFollowUp ?? false;
  await recordJobEvent(tx, tenantId, jobId, {
    type: "job.outcome_recorded",
    actor,
    payload: {
      outcomeId: created.id,
      outcome: input.outcome,
      visitNumber: job.currentVisitNumber,
      lostReasonId: lostReason?.id ?? null,
      customerRequestedFollowUp,
      fromStatus: change.from,
      toStatus: change.to,
      retroactive,
    },
  });
  if (notConverted) {
    await recordJobEvent(tx, tenantId, jobId, {
      type: "job.not_converted",
      actor,
      payload: { outcomeId: created.id, outcome: input.outcome, lostReasonId: lostReason?.id ?? null, recoverable: lostReason?.recoverable ?? null },
    });
  }
  // Money is audited by field NAME only (the amounts live in the outcome row, readable by those who may view them).
  const moneyFields = (["quotedAmountMinor", "approvedAmountMinor", "chargedAmountMinor", "collectedAmountMinor"] as const).filter((field) => input[field] !== undefined);
  await recordAudit(tx, {
    ...audit,
    action: "job_outcome.record",
    targetType: "JobOutcome",
    targetId: created.id,
    newValue: { jobId, outcome: input.outcome, visitNumber: job.currentVisitNumber, lostReasonId: lostReason?.id ?? null, moneyFields, retroactive },
    reason: retroactive ? "Retroactive outcome: the job was already past its visit" : undefined,
  });

  await publishOutcomeRecorded(tx, {
    tenantId,
    jobId,
    outcomeId: created.id,
    visitNumber: job.currentVisitNumber,
    outcome: input.outcome,
    lostReasonId: lostReason?.id ?? null,
    lostReasonRecoverable: lostReason?.recoverable ?? null,
    notConverted,
    customerRequestedFollowUp,
    retroactive,
    jobStatus: change.to,
  });
  const notificationIds = notConverted ? await notifyNotConverted(tx, actor, { id: jobId, number: jobFacts.number, orgUnitId: job.orgUnitId }, created.id) : [];
  return { outcomeId: created.id, replayed: false, retroactive, decision, notificationIds };
}

async function viewRecorded(tx: TenantTx, actor: Actor, outcomeId: string, decision: AccessDecision, replayed: boolean): Promise<RecordedOutcome> {
  const row: OutcomeRow = await tx.jobOutcome.findFirstOrThrow({ where: { id: outcomeId, tenantId: actor.tenantId }, select: outcomeRowSelect });
  const job = await tx.job.findFirstOrThrow({ where: { id: row.jobId, tenantId: actor.tenantId }, select: { id: true, status: true, currentVisitNumber: true } });
  // Money shows only when the caller's grant names the financial set.
  return { outcome: projectFields(row, decision, OUTCOME_FIELD_MAP), job, replayed };
}

/**
 * The submission as it will be stored (defaults applied), so a client that omits a default and one that sends it explicitly hash the same.
 * `occurredAt` stays out when omitted (it defaults to "now", which differs per call).
 */
function normalizedSubmission(input: RecordOutcomeInput, jobCurrency: string): Record<string, unknown> {
  return {
    outcome: input.outcome,
    lostReasonId: input.lostReasonId ?? null,
    notes: input.notes ?? null,
    quotedAmountMinor: input.quotedAmountMinor ?? null,
    approvedAmountMinor: input.approvedAmountMinor ?? null,
    chargedAmountMinor: input.chargedAmountMinor ?? null,
    collectedAmountMinor: input.collectedAmountMinor ?? null,
    currency: input.currency ?? jobCurrency,
    paymentMethod: input.paymentMethod ?? null,
    paymentStatus: input.paymentStatus ?? "NOT_APPLICABLE",
    customerRequestedFollowUp: input.customerRequestedFollowUp ?? false,
    preferredFollowUpAt: input.preferredFollowUpAt?.toISOString() ?? null,
    occurredAt: input.occurredAt?.toISOString() ?? null,
  };
}

/**
 * `POST /jobs/{id}/outcome`: reports the outcome of the job's current visit.
 *
 * Offline envelope (§8.7, §25.3): with a `clientEventId` and an employee actor, the submission goes through the shared
 * field-event gate (`field-events`, type `job.outcome`): the same id with the same content returns the original result
 * with `replayed: true`; the same id with DIFFERENT content (or on another job) is a 409 `field_event.payload_mismatch`.
 * Two copies arriving at once serialise on the gate's unique key. A replay is still a read of the outcome, so the
 * caller must hold the permission over the job NOW.
 */
export async function recordJobOutcome(actor: Actor, ctx: RequestContext, jobId: string, input: RecordOutcomeInput): Promise<RecordedOutcome> {
  const notificationIds: string[] = [];
  const audit = auditContextFields(ctx);

  if (!input.clientEventId || !actor.employeeId) {
    const result = await conflictOnUniqueViolation("This clientEventId was already used for a different submission.", () =>
      withTenant(actor.tenantId, async (tx) => {
        const recorded = await recordOutcomeInTx(tx, actor, audit, jobId, input);
        notificationIds.push(...recorded.notificationIds);
        return viewRecorded(tx, actor, recorded.outcomeId, recorded.decision, recorded.replayed);
      }),
    );
    await deliverAfterCommit(actor.tenantId, notificationIds);
    return result;
  }

  const employeeId = actor.employeeId;
  const job = await withTenant(actor.tenantId, (tx) => tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: { currency: true } }));
  if (!job) throw new NotFoundError();
  const outcome = await runFieldEvent<RecordedOutcome>(
    {
      tenantId: actor.tenantId,
      employeeId,
      actorUserId: actor.userId,
      type: "job.outcome",
      clientEventId: input.clientEventId,
      occurredAt: input.occurredAt ?? new Date(),
      jobId,
      payload: { outcome: input.outcome },
      // The job id is part of the meaning: one id used on two jobs is a conflict, not a second outcome.
      payloadHash: hashFieldEventContent({ type: "job.outcome", jobId, submission: normalizedSubmission(input, job.currency) }),
      reusedIdCode: "field_event.payload_mismatch",
    },
    {
      apply: async (tx) => {
        const recorded = await recordOutcomeInTx(tx, actor, audit, jobId, input);
        notificationIds.push(...recorded.notificationIds);
        return { result: await viewRecorded(tx, actor, recorded.outcomeId, recorded.decision, recorded.replayed), entity: { type: "JobOutcome", id: recorded.outcomeId } };
      },
      replay: async (tx, entity) => {
        const resource = await jobResourceRef(tx, actor.tenantId, jobId);
        if (!resource) throw new NotFoundError();
        const { decision } = await authorizeRecording(tx, actor, resource);
        return viewRecorded(tx, actor, entity.id, decision, true);
      },
    },
  );
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
}
