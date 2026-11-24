import { checkOccurredAt, hashFieldEventContent } from "@/lib/location-rules";
import type { JobStatusValue } from "@/lib/job-lifecycle";
import { enforceInTx, type ResourceRef } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { runFieldEvent, type FieldEventEntity } from "@/server/field-events";
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

const PRE_FIELD_STATUSES: readonly JobStatusValue[] = ["CREATED", "PENDING_ASSIGNMENT", "ASSIGNED", "SCHEDULED"];

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
      retryable: PRE_FIELD_STATUSES.includes(job.status),
      message: "Field records can only be added once the job is under way and before it is closed.",
      details: [{ field: "jobId", code: "job_field.not_in_field_state", message: `The job is ${job.status}.` }],
    });
  }
  const { currency } = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId: actor.tenantId }, select: { currency: true } });
  return { ref, job, currency, mayHandleMoney: await holdsOutcomeFinancialSet(tx, actor, ref) };
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
 * The device time must be believable: not ahead of the server clock beyond drift (retryable: it becomes valid later) and
 * not older than a week (§8.7). Judged on FIRST delivery only, inside the work: a late replay of an event that was already
 * accepted must still be answered from the stored result, not refused because it is now "too old".
 */
function assertBelievableTime(occurredAt: Date | undefined, now: Date): void {
  if (!occurredAt) return;
  const problem = checkOccurredAt(occurredAt, now);
  if (problem === null) return;
  throw new ValidationError({ message: "The event time is in the future or too old to accept.", field: "occurredAt", retryable: problem === "IN_THE_FUTURE" });
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
    assertBelievableTime(spec.envelope.occurredAt, now);
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
