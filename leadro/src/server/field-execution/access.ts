import { hashFieldEventContent } from "@/lib/location-rules";
import { canStillReach, type JobStatusValue } from "@/lib/job-lifecycle";
import { enforceInTx, type ResourceRef } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assertBelievableEventTime, runFieldEvent, type FieldEventEntity } from "@/server/field-events";
import { jobResourceRef, loadJobForChange, type JobForChange } from "@/server/jobs";
import { holdsOutcomeFinancialSet } from "@/server/job-outcomes";

/**
 * Who may do what on a job in the field, and the offline envelope every field write shares (§8.5, §8.7).
 *
 * Authorization reuses the grants that already describe a technician's day (no new permission): writing needs
 * `jobs.edit` over the job (the Technician's `execution` grant is ASSIGNED-scoped, managers hold it by unit), reading
 * needs `jobs.view`. Money in a note (the estimate of additional work) additionally needs the `financial` field set of
 * the outcome grant, the same rule as the visit's outcome amounts.
 */

/** Statuses in which field records may be added: from leaving for the job until it is closed. */
const FIELD_RECORDING_STATUSES: readonly JobStatusValue[] = [
  "EN_ROUTE",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "AWAITING_REVIEW",
  "REQUIRES_RETURN_VISIT",
  "CUSTOMER_UNAVAILABLE",
  "FAILED",
  "ON_HOLD",
  "RESCHEDULED",
];

export interface FieldJobContext {
  ref: ResourceRef;
  /** The locked job (status, current visit). */
  job: JobForChange;
  currency: string;
  /** May the caller send or see money (the `financial` field set of `job_outcomes`)? */
  mayHandleMoney: boolean;
}

/** `jobs.view` over the job (404 outside the caller's scope); for reads. */
export async function authorizeFieldRead(tx: TenantTx, actor: Actor, jobId: string): Promise<ResourceRef> {
  await enforceInTx(tx, actor, "jobs.view");
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  await enforceInTx(tx, actor, "jobs.view", ref);
  return ref;
}

/**
 * `jobs.edit` over the job, then locks it (concurrent writers queue up) and checks it is in the field phase.
 * @throws NotFoundError (outside scope), ForbiddenError, InvalidStateTransitionError (`job_field.not_in_field_state`).
 */
export async function authorizeFieldWrite(tx: TenantTx, actor: Actor, jobId: string): Promise<FieldJobContext> {
  await enforceInTx(tx, actor, "jobs.edit");
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  await enforceInTx(tx, actor, "jobs.edit", ref);
  const job = await loadJobForChange(tx, actor.tenantId, jobId);
  if (!FIELD_RECORDING_STATUSES.includes(job.status)) {
    throw new InvalidStateTransitionError({
      // Before the field phase the earlier events (EN_ROUTE...) may not have synced yet: retryable, never stored.
      retryable: canStillReach(job.status, "EN_ROUTE"),
      message: "Field records can only be added once the job is under way and before it is closed.",
      details: [{ field: "jobId", code: "job_field.not_in_field_state", message: `The job is ${job.status}.` }],
    });
  }
  const { currency } = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId: actor.tenantId }, select: { currency: true } });
  return { ref, job, currency, mayHandleMoney: await holdsOutcomeFinancialSet(tx, actor, ref) };
}

/**
 * Statements made in the customer's name (their approval of extra work) and the completion form are the act of the person
 * who worked the visit: only an employee ASSIGNED to the job may make them. Managers can still read and correct records
 * through the audited paths, but never speak for the customer or sign off the work.
 * @throws ForbiddenError
 */
export function assertWorkedByCaller(ref: ResourceRef, actor: Actor, what: string): void {
  if (!actor.employeeId || !ref.assignedEmployeeIds?.includes(actor.employeeId)) {
    throw new ForbiddenError({ message: `Only an employee assigned to the job can record ${what}.` });
  }
}

export interface FieldWriteEnvelope {
  clientEventId?: string;
  occurredAt?: Date;
  deviceId?: string;
}

export interface JobFieldWriteSpec<T> {
  /** Dotted event type, e.g. `job.note`. */
  type: string;
  jobId: string;
  envelope: FieldWriteEnvelope;
  /** EVERYTHING that defines the event (free text included): hashed, never stored. */
  content: unknown;
  /** Ids and enum values stored in `FieldEvent.payload`. */
  payload: Record<string, string | number | boolean | null>;
  /** First delivery: does the work and says what it created. `occurredAt` is the device time (or now). */
  apply: (tx: TenantTx, occurredAt: Date) => Promise<{ result: T; entity: FieldEventEntity }>;
  /** Later delivery of an accepted event: the entity as it is now, re-checked for the caller's access. */
  replay: (tx: TenantTx, entityId: string) => Promise<T>;
}

/**
 * Runs one job-scoped field write, through the shared offline gate when it carries a `clientEventId` (idempotent per
 * employee, a changed payload under a reused id is a 409, a content refusal is remembered), plainly otherwise.
 */
export async function runJobFieldWrite<T>(actor: Actor, spec: JobFieldWriteSpec<T>): Promise<{ result: T; replayed: boolean }> {
  const now = new Date();
  const occurredAt = spec.envelope.occurredAt ?? now;
  const { clientEventId } = spec.envelope;
  if (!clientEventId) {
    assertBelievableEventTime(spec.envelope.occurredAt, now);
    const done = await withTenant(actor.tenantId, (tx) => spec.apply(tx, occurredAt));
    return { result: done.result, replayed: false };
  }
  if (!actor.employeeId) throw new ValidationError({ message: "Offline events need an employee record.", field: "clientEventId" });
  const outcome = await runFieldEvent<T>(
    {
      tenantId: actor.tenantId,
      employeeId: actor.employeeId,
      actorUserId: actor.userId,
      type: spec.type,
      clientEventId,
      occurredAt,
      deviceId: spec.envelope.deviceId,
      jobId: spec.jobId,
      payload: spec.payload,
      // What the device sent: a defaulted occurredAt is not part of it, so a retry without one still matches.
      payloadHash: hashFieldEventContent({ type: spec.type, jobId: spec.jobId, content: spec.content, occurredAt: spec.envelope.occurredAt }),
    },
    {
      // The gate judges the device time on first delivery only.
      apply: (tx) => spec.apply(tx, occurredAt),
      replay: (tx, entity) => spec.replay(tx, entity.id),
    },
  );
  return { result: outcome.result, replayed: outcome.replayed };
}
