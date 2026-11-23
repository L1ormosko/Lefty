import { MAX_CLOCK_SKEW_MS, checkOccurredAt, hashFieldEventContent } from "@/lib/location-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, LOCATION_EVENT_FIELD_MAP, projectFields, type AccessDecision } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { runFieldEvent } from "./field-events";
import { recordLocationEventInTx } from "./record";
import type { RecordLocationEventInput } from "./schemas";
import { locationEventSelect, locationEventView } from "./views";

/**
 * A technician reports one of their own location events from the field: "navigation opened" or "departed" for a job
 * assigned to them (spec 8.3, 17.1). Arrival and shift events have their own flows (arrival verification, shifts);
 * everything is event-based, nothing here is a polling or tracking endpoint.
 *
 * Rules:
 *  - needs `location.create` for the caller's OWN record; the event is always about the caller (a body cannot name
 *    another employee), and the job must be assigned to the caller, else 404;
 *  - NAVIGATION_OPENED never changes a job status and never counts as arrival: this service does not touch the job;
 *  - a position carries its accuracy and device time; without one the caller says why (`exception`), except for
 *    NAVIGATION_OPENED, which is informational and may have no position at all;
 *  - the response is projected with the field sets of the `location.create` grant, so it never echoes coordinates.
 *
 * Offline (spec 8.7): with a `clientEventId` the call is idempotent per employee; a repeat answers with the original
 * event, a repeat with different content is `409`.
 */

const EVENT_TYPE: Record<RecordLocationEventInput["kind"], string> = {
  DEPARTURE: "location.departure",
  NAVIGATION_OPENED: "location.navigation_opened",
};

async function ownEventDecision(tx: TenantTx, actor: Actor & { employeeId: string }, jobId: string): Promise<AccessDecision> {
  const decision = await enforceInTx(tx, actor, "location.create", { employeeId: actor.employeeId, ownerEmployeeId: actor.employeeId });
  // The job must be one of the caller's: a person who can merely see a job may not report positions "on" it.
  const jobRef = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!jobRef) throw new NotFoundError();
  await enforceInTx(tx, actor, "jobs.view", jobRef);
  if (!jobRef.assignedEmployeeIds?.includes(actor.employeeId)) throw new NotFoundError();
  return decision;
}

async function viewStored(tx: TenantTx, actor: Actor, eventId: string, decision: AccessDecision): Promise<Record<string, unknown>> {
  const row = await tx.locationEvent.findFirst({ where: { id: eventId, tenantId: actor.tenantId }, select: locationEventSelect });
  if (!row) throw new NotFoundError();
  return projectFields(locationEventView(row), decision, LOCATION_EVENT_FIELD_MAP);
}

export interface RecordedEventResult {
  event: Record<string, unknown>;
  /** True when a repeated clientEventId was answered from the first delivery. */
  replayed: boolean;
}

export async function recordLocationEvent(actor: Actor, ctx: RequestContext, input: RecordLocationEventInput): Promise<RecordedEventResult> {
  if (!actor.employeeId) throw new ForbiddenError();
  const self = { ...actor, employeeId: actor.employeeId };
  const now = new Date();
  // The two device clocks the client may send must tell the same story, else one of them is wrong and we cannot say which.
  if (input.occurredAt && input.position && Math.abs(input.occurredAt.getTime() - input.position.deviceTime.getTime()) > MAX_CLOCK_SKEW_MS) {
    throw new ValidationError({ message: "occurredAt and the position's device time disagree.", field: "occurredAt" });
  }
  const occurredAt = input.occurredAt ?? input.position?.deviceTime ?? now;
  if (checkOccurredAt(occurredAt, now) !== null) {
    throw new ValidationError({ message: "The event time is in the future or too old to accept.", field: "occurredAt" });
  }

  const write = async (tx: TenantTx, fieldEventId: string | undefined): Promise<{ event: Record<string, unknown>; id: string }> => {
    const decision = await ownEventDecision(tx, self, input.jobId);
    const recorded = await recordLocationEventInTx(
      tx,
      {
        tenantId: actor.tenantId,
        employeeId: self.employeeId,
        kind: input.kind,
        source: input.position ? "DEVICE_GPS" : "MANUAL",
        position: input.position,
        // A manual entry (no position) still keeps WHEN it happened on the device, when the client said so.
        deviceTime: input.position?.deviceTime ?? input.occurredAt ?? null,
        jobId: input.jobId,
        deviceId: input.deviceId,
        exception: input.exception?.code,
        exceptionNote: input.exception?.note,
        fieldEventId,
      },
      now,
    );
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "location.record",
      targetType: "LocationEvent",
      targetId: recorded.id,
      // §22.2: audit values never hold coordinates; accuracy, kind and source are enough to reconstruct what happened.
      newValue: { kind: recorded.kind, source: recorded.source, jobId: input.jobId, hasPosition: recorded.hasPosition, accuracyM: recorded.accuracyM, exception: input.exception?.code ?? null },
    });
    return { event: await viewStored(tx, actor, recorded.id, decision), id: recorded.id };
  };

  if (!input.clientEventId) {
    const written = await withTenant(actor.tenantId, (tx) => write(tx, undefined));
    return { event: written.event, replayed: false };
  }

  const outcome = await runFieldEvent<Record<string, unknown>>(
    {
      tenantId: actor.tenantId,
      employeeId: self.employeeId,
      actorUserId: actor.userId,
      type: EVENT_TYPE[input.kind],
      clientEventId: input.clientEventId,
      occurredAt,
      deviceId: input.deviceId,
      jobId: input.jobId,
      payload: { kind: input.kind, jobId: input.jobId },
      // What the event MEANS, as sent (a defaulted occurredAt is not part of it). Coordinates are hashed (one-way): a changed position under a reused id is a CONFLICT.
      payloadHash: hashFieldEventContent({ type: EVENT_TYPE[input.kind], kind: input.kind, jobId: input.jobId, occurredAt: input.occurredAt, position: input.position, exception: input.exception }),
    },
    {
      apply: async (tx, fieldEventId) => {
        const written = await write(tx, fieldEventId);
        return { result: written.event, entity: { type: "LocationEvent", id: written.id } };
      },
      replay: async (tx, entity) => viewStored(tx, actor, entity.id, await ownEventDecision(tx, self, input.jobId)),
    },
  );
  return { event: outcome.result, replayed: outcome.replayed };
}
