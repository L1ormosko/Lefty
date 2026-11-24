import { checkOccurredAt, hashFieldEventContent } from "@/lib/location-rules";
import type { JobStatusValue } from "@/lib/job-lifecycle";
import { canInTx, enforceInTx, type ResourceRef } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { runFieldEvent, type FieldEventEntity } from "@/server/field-events";
import { jobResourceRef, loadJobForChange, type JobForChange } from "@/server/jobs";

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

/** Does the caller's `job_outcomes.view` grant over the job include the financial set? */
export async function holdsFinancialSet(tx: TenantTx, actor: Actor, ref: ResourceRef): Promise<boolean> {
  const decision = await canInTx(tx, actor, "job_outcomes.view", ref);
  return decision.allowed && decision.fieldSets.includes("financial");
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
  return { ref, job, currency, mayHandleMoney: await holdsFinancialSet(tx, actor, ref) };
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
 * employee, a changed payload under a reused id is a 409, a refusal is remembered), plainly otherwise. A device time in
 * the future (beyond clock drift) or older than a week is refused (§8.7).
 */
export async function runJobFieldWrite<T>(actor: Actor, spec: JobFieldWriteSpec<T>): Promise<{ result: T; replayed: boolean }> {
  const now = new Date();
  const occurredAt = spec.envelope.occurredAt ?? now;
  if (spec.envelope.occurredAt && checkOccurredAt(occurredAt, now) !== null) {
    throw new ValidationError({ message: "The event time is in the future or too old to accept.", field: "occurredAt" });
  }
  const { clientEventId } = spec.envelope;
  if (!clientEventId) {
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
    { apply: (tx) => spec.apply(tx, occurredAt), replay: (tx, entity) => spec.replay(tx, entity.id) },
  );
  return { result: outcome.result, replayed: outcome.replayed };
}
