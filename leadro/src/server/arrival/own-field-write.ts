import { checkOccurredAt } from "@/lib/location-rules";
import { enforceInTx, type ResourceRef } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { runFieldEvent, type FieldEventEntity } from "@/server/field-events";

/**
 * Shared shell of the technician's job field writes (arrive, start work): the caller must be an employee, the job
 * must be assigned to them (anyone else gets 404, like a job they cannot see), the device time must be believable,
 * and the write runs once per `clientEventId` (offline replays answer from the first delivery, §8.7, §25.3).
 */

export type EmployeeActor = Actor & { employeeId: string };

export function requireEmployee(actor: Actor): EmployeeActor {
  if (!actor.employeeId) throw new ForbiddenError();
  return { ...actor, employeeId: actor.employeeId };
}

/**
 * `occurredAt` (device time of an offline event) must not be in the future or ancient; defaults to now. `judgedByGate`: the
 * write carries a `clientEventId`, so the shared gate judges the RAW time on first delivery only; the value returned here is
 * clamped to the server clock and is for storage, never for the gate.
 */
export function eventTime(occurredAt: Date | undefined, now: Date, judgedByGate = false): Date {
  const at = occurredAt ?? now;
  if (!judgedByGate && checkOccurredAt(at, now) !== null) throw new ValidationError({ message: "The event time is in the future or too old to accept.", field: "occurredAt" });
  // The tolerance above is only for ACCEPTING a device clock that runs ahead; what is stored is never later than the server clock.
  return at.getTime() > now.getTime() ? now : at;
}

/** The job's scope attributes, after checking the job is assigned to the caller. 404 when it is not theirs. */
export async function assignedJobRef(tx: TenantTx, actor: EmployeeActor, jobId: string): Promise<ResourceRef> {
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  await enforceInTx(tx, actor, "jobs.view", ref);
  if (!ref.assignedEmployeeIds?.includes(actor.employeeId)) throw new NotFoundError();
  return ref;
}

export interface OwnFieldWrite<T> {
  actor: EmployeeActor;
  jobId: string;
  /** Dotted FieldEvent type, e.g. `job.arrive`. */
  type: string;
  clientEventId?: string;
  occurredAt: Date;
  deviceId?: string;
  /** What the event means (hashed): the same clientEventId with other content is a CONFLICT. */
  payloadHash: string;
  apply: (tx: TenantTx, fieldEventId: string | undefined) => Promise<{ result: T; entity: FieldEventEntity }>;
  replay: (tx: TenantTx, entity: FieldEventEntity) => Promise<T>;
}

export async function runOwnFieldWrite<T>(write: OwnFieldWrite<T>): Promise<{ result: T; replayed: boolean }> {
  if (!write.clientEventId) {
    const applied = await withTenant(write.actor.tenantId, (tx) => write.apply(tx, undefined));
    return { result: applied.result, replayed: false };
  }
  return runFieldEvent<T>(
    {
      tenantId: write.actor.tenantId,
      employeeId: write.actor.employeeId,
      actorUserId: write.actor.userId,
      type: write.type,
      clientEventId: write.clientEventId,
      occurredAt: write.occurredAt,
      deviceId: write.deviceId,
      jobId: write.jobId,
      payload: { jobId: write.jobId },
      payloadHash: write.payloadHash,
    },
    { apply: (tx, fieldEventId) => write.apply(tx, fieldEventId), replay: write.replay },
  );
}
