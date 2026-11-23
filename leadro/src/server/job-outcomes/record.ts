import { NOT_CONVERTED_OUTCOMES, outcomeProblem, outcomeTargetStatus, type JobOutcomeTypeValue } from "@/lib/job-outcome-rules";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { enforceInTx, projectFields } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, ValidationError, hashIdempotentRequest, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { changeJobStatus, jobResourceRef, loadJobForChange, recordJobEvent } from "@/server/jobs";
import { deliverAfterCommit } from "@/server/notifications";
import { OUTCOME_FIELD_MAP, outcomeRowSelect, type OutcomeRow } from "./fields";
import { publishOutcomeRecorded } from "./events";
import { notifyNotConverted } from "./notify";
import type { RecordOutcomeInput } from "./schemas";

/**
 * Recording the outcome of a visit (§9.1). One outcome per `(job, visitNumber)`; recording it also moves the
 * job along the lifecycle (`OUTCOME_STATUS_RULES`), writes the job's events (`job.outcome_recorded`, plus
 * `job.not_converted` for unsuccessful visits), an audit row, tells the managers about a lost visit and
 * publishes the domain event the recovery engine subscribes to. All of it is one transaction.
 */

/** How far into the future a device clock may be before `occurredAt` is refused (clock drift, not a time machine). */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface RecordedOutcome {
  outcome: Record<string, unknown>;
  job: { id: string; status: string; currentVisitNumber: number };
  /** True when this call returned the result of an earlier identical submission (offline replay). */
  replayed: boolean;
}

interface InTxResult {
  outcomeId: string;
  replayed: boolean;
  notificationIds: string[];
}

const refusal = (field: string, code: string, message: string): ValidationError =>
  new ValidationError({ message, field, details: [{ field, code, message }] });

/** The lost reason must exist, be active and apply to the outcome. Returns its `recoverable` flag. */
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
 * The domain work of recording an outcome, inside the caller's transaction (the API and the offline
 * sync both call it). The caller has NOT locked anything: this locks the job first. Authorization is
 * `job_outcomes.create` over the job.
 *
 * Replays: when `input.clientEventId` already recorded an outcome for this job, that outcome is returned
 * (`replayed: true`) and nothing is written. A second, different outcome for the same visit is a 409.
 *
 * @returns the outcome id, whether it was a replay, and the notification ids to deliver after commit.
 */
export async function recordOutcomeInTx(tx: TenantTx, actor: Actor, audit: AuditContextFields, jobId: string, input: RecordOutcomeInput): Promise<InTxResult> {
  const tenantId = actor.tenantId;
  const job = await loadJobForChange(tx, tenantId, jobId); // locks the row: concurrent submissions queue up here
  const resource = await jobResourceRef(tx, tenantId, jobId);
  if (!resource) throw new NotFoundError();
  await enforceInTx(tx, actor, "job_outcomes.create", resource);

  if (input.clientEventId) {
    const replay = await tx.jobOutcome.findFirst({ where: { tenantId, jobId, clientEventId: input.clientEventId }, select: { id: true } });
    if (replay) return { outcomeId: replay.id, replayed: true, notificationIds: [] };
  }
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) throw refusal("occurredAt", "job_outcome.occurred_in_future", "The time of the outcome cannot be in the future.");

  const existing = await tx.jobOutcome.findFirst({ where: { tenantId, jobId, visitNumber: job.currentVisitNumber }, select: { id: true } });
  if (existing) {
    throw new ConflictError({
      message: "An outcome was already recorded for this visit.",
      details: [{ field: "outcome", code: "job_outcome.already_recorded", message: "An outcome was already recorded for this visit." }],
    });
  }
  const targetStatus = outcomeTargetStatus(input.outcome, job.status);
  if (!targetStatus) {
    throw new InvalidStateTransitionError({
      message: `The outcome ${input.outcome} cannot be reported while the job is ${job.status}.`,
      details: [{ field: "outcome", code: "job_outcome.not_reportable", message: `The outcome ${input.outcome} cannot be reported while the job is ${job.status}.` }],
    });
  }

  assertConsistent(input);
  const lostReason = input.lostReasonId ? await checkLostReason(tx, tenantId, input.lostReasonId, input.outcome) : null;
  const jobFacts = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId }, select: { currency: true, number: true } });

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
      currency: input.currency ?? jobFacts.currency,
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

  // The job follows the outcome through its own lifecycle (guards, tenant narrowing, history). The status reason names the outcome, not free text.
  const statusReason = `Outcome ${input.outcome}${lostReason ? ` (${lostReason.code})` : ""}`;
  const change = await changeJobStatus(tx, actor, audit, job, targetStatus, { reason: statusReason });

  const notConverted = NOT_CONVERTED_OUTCOMES.includes(input.outcome);
  const customerRequestedFollowUp = input.customerRequestedFollowUp ?? false;
  const eventPayload = {
    outcomeId: created.id,
    outcome: input.outcome,
    visitNumber: job.currentVisitNumber,
    lostReasonId: lostReason?.id ?? null,
    customerRequestedFollowUp,
    fromStatus: change.from,
    toStatus: change.to,
  };
  await recordJobEvent(tx, tenantId, jobId, { type: "job.outcome_recorded", actor, payload: eventPayload });
  if (notConverted) {
    await recordJobEvent(tx, tenantId, jobId, {
      type: "job.not_converted",
      actor,
      payload: { outcomeId: created.id, outcome: input.outcome, lostReasonId: lostReason?.id ?? null, recoverable: lostReason?.recoverable ?? null },
    });
  }
  // Money is audited by field NAME only (the amounts live in the outcome row, readable by those who may view it).
  const moneyFields = (["quotedAmountMinor", "approvedAmountMinor", "chargedAmountMinor", "collectedAmountMinor"] as const).filter((field) => input[field] !== undefined);
  await recordAudit(tx, {
    ...audit,
    action: "job_outcome.record",
    targetType: "JobOutcome",
    targetId: created.id,
    newValue: { jobId, outcome: input.outcome, visitNumber: job.currentVisitNumber, lostReasonId: lostReason?.id ?? null, moneyFields },
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
    jobStatus: change.to,
  });
  const notificationIds = notConverted ? await notifyNotConverted(tx, actor, { id: jobId, number: jobFacts.number, orgUnitId: job.orgUnitId }, created.id) : [];
  return { outcomeId: created.id, replayed: false, notificationIds };
}

async function viewRecorded(tx: TenantTx, actor: Actor, outcomeId: string, replayed: boolean): Promise<RecordedOutcome> {
  const row: OutcomeRow = await tx.jobOutcome.findFirstOrThrow({ where: { id: outcomeId, tenantId: actor.tenantId }, select: outcomeRowSelect });
  const job = await tx.job.findFirstOrThrow({ where: { id: row.jobId, tenantId: actor.tenantId }, select: { id: true, status: true, currentVisitNumber: true } });
  // The caller just proved `job_outcomes.create` over the job; the response shows the base fields they wrote.
  return { outcome: projectFields(row, { allowed: true, fieldSets: ["base"] }, OUTCOME_FIELD_MAP), job, replayed };
}

/**
 * `POST /jobs/{id}/outcome`: reports the outcome of the job's current visit.
 *
 * Offline envelope (§8.7, §25.3): with a `clientEventId` and an employee actor, the submission is stored as a
 * `FieldEvent` (idempotent per tenant, employee and id). Sending the same id with the same content again returns
 * the original result with `replayed: true`; the same id with DIFFERENT content is a 409 (the device is confused,
 * and silently picking one would hide data).
 */
export async function recordJobOutcome(actor: Actor, ctx: RequestContext, jobId: string, input: RecordOutcomeInput): Promise<RecordedOutcome> {
  const notificationIds: string[] = [];
  const result = await withTenant(actor.tenantId, async (tx) => {
    const gate = input.clientEventId && actor.employeeId ? { clientEventId: input.clientEventId, employeeId: actor.employeeId } : null;
    // The payload hash covers the whole submission, so a different body under the same id is detectable.
    const payloadHash = hashIdempotentRequest({ actorUserId: gate?.employeeId ?? actor.userId, method: "JOB_OUTCOME", path: jobId, body: JSON.parse(JSON.stringify(input)) });

    if (gate) {
      // Lock the job first so two copies of one submission arriving together are serialized, then judge by the stored event.
      await loadJobForChange(tx, actor.tenantId, jobId);
      const earlier = await tx.fieldEvent.findFirst({
        where: { tenantId: actor.tenantId, employeeId: gate.employeeId, clientEventId: gate.clientEventId },
        select: { payloadHash: true, entityId: true, result: true },
      });
      if (earlier) {
        if (earlier.payloadHash !== payloadHash || earlier.result !== "ACCEPTED" || !earlier.entityId) {
          throw new ConflictError({
            message: "This clientEventId was already used for a different submission.",
            details: [{ field: "clientEventId", code: "field_event.payload_mismatch", message: "This clientEventId was already used for a different submission." }],
          });
        }
        return viewRecorded(tx, actor, earlier.entityId, true);
      }
    }

    const recorded = await recordOutcomeInTx(tx, actor, auditContextFields(ctx), jobId, input);
    if (gate && !recorded.replayed) {
      await tx.fieldEvent.create({
        data: {
          tenantId: actor.tenantId,
          employeeId: gate.employeeId,
          actorUserId: actor.userId,
          clientEventId: gate.clientEventId,
          type: "job.outcome",
          jobId,
          occurredAt: input.occurredAt ?? new Date(),
          payload: { outcomeId: recorded.outcomeId, outcome: input.outcome },
          payloadHash,
          result: "ACCEPTED",
          entityType: "JobOutcome",
          entityId: recorded.outcomeId,
        },
      });
    }
    notificationIds.push(...recorded.notificationIds);
    return viewRecorded(tx, actor, recorded.outcomeId, recorded.replayed);
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}
