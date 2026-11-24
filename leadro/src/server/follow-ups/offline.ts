import { hashFieldEventContent } from "@/lib/location-rules";
import { ValidationError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { runFieldEvent } from "@/server/field-events";
import { deliverAfterCommit } from "@/server/notifications";

/**
 * Offline-safe field writes for follow-ups (§8.7, §25.3). A write that carries a `clientEventId` goes through the shared
 * field-event gate (`src/server/field-events`: idempotent per (tenant, employee, clientEventId), same id with different
 * content is a 409, business refusals are stored REJECTED and replayed identically, permission failures are not stored).
 * This file only adapts follow-up writes to it: the future-time rule, the content hash and notification delivery.
 * Without a `clientEventId` the write simply runs. Coordinates never go here; the payload holds ids and codes, free text
 * stays in the domain row.
 */

export interface OfflineFields {
  clientEventId?: string;
  /** When it happened on the device. Defaults to now; a time in the future is refused. */
  occurredAt?: Date;
}

export interface FieldWriteSpec {
  /** Dotted lower-case event type, e.g. `follow_up.complete`. */
  type: string;
  /** EVERYTHING that defines the event (including free text): hashed, never stored. */
  content: unknown;
  /** Ids and enum values stored in `FieldEvent.payload`. */
  payload: Record<string, string | number | boolean | null>;
}

/** What `run` returns: the affected row, the answer for the caller, and notifications to deliver after commit. */
export interface FieldWriteOutcome<T> {
  entityType: string;
  entityId: string;
  value: T;
  notificationIds: string[];
}

/** Clock skew tolerated for a client-supplied `occurredAt`. */
const FUTURE_SKEW_MS = 60_000;

/** `occurredAt` is the CLIENT's time (undefined when it sent none: "now" differs on every retry and must not enter the hash). */
export const hashFieldEvent = (spec: FieldWriteSpec, occurredAt: Date | undefined): string =>
  hashFieldEventContent({ type: spec.type, content: spec.content, occurredAt });

/**
 * Runs a field write. `run(tx, occurredAt)` does the work inside the transaction and returns the outcome; `replay(tx, entityId)`
 * rebuilds the answer of an already accepted event (the entity as it is now, re-checked for the caller's access).
 */
export async function runFieldWrite<T>(
  actor: Actor,
  offline: OfflineFields,
  spec: FieldWriteSpec,
  run: (tx: TenantTx, occurredAt: Date) => Promise<FieldWriteOutcome<T>>,
  replay: (tx: TenantTx, entityId: string) => Promise<T>,
): Promise<T> {
  const now = new Date();
  const occurredAt = offline.occurredAt ?? now;
  // With a clientEventId the shared gate judges the device time on first delivery only (a late replay must still answer).
  if (!offline.clientEventId && occurredAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    throw new ValidationError({ message: "An event cannot happen in the future.", field: "occurredAt" });
  }

  if (!offline.clientEventId) {
    const outcome = await withTenant(actor.tenantId, (tx) => run(tx, occurredAt));
    await deliverAfterCommit(actor.tenantId, outcome.notificationIds);
    return outcome.value;
  }
  if (!actor.employeeId) {
    throw new ValidationError({ message: "Offline events need an employee record.", field: "clientEventId" });
  }

  const notificationIds: string[] = [];
  const outcome = await runFieldEvent<T>(
    {
      tenantId: actor.tenantId,
      employeeId: actor.employeeId,
      actorUserId: actor.userId,
      type: spec.type,
      clientEventId: offline.clientEventId,
      occurredAt,
      payload: spec.payload,
      payloadHash: hashFieldEvent(spec, offline.occurredAt),
    },
    {
      apply: async (tx) => {
        const done = await run(tx, occurredAt);
        notificationIds.push(...done.notificationIds);
        return { result: done.value, entity: { type: done.entityType, id: done.entityId } };
      },
      replay: (tx, entity) => replay(tx, entity.id),
    },
  );
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return outcome.result;
}
