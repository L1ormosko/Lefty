import { exceptionForReviewReason, judgeArrival } from "@/lib/arrival-rules";
import { MAX_CLOCK_SKEW_MS, hashFieldEventContent } from "@/lib/location-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, projectFields } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { changeJobStatus, loadJobForChange, recordJobEvent } from "@/server/jobs";
import { loadLocationSettings, recordLocationEventInTx, withoutCoordinates } from "@/server/location";
import { deliverAfterCommit } from "@/server/notifications";
import { ARRIVAL_FIELD_MAP, arrivalSelect, arrivalView } from "./fields";
import { notifyArrivalNeedsReview } from "./notify";
import { assignedJobRef, eventTime, requireEmployee, runOwnFieldWrite, type EmployeeActor } from "./own-field-write";
import type { ArriveInput } from "./schemas";

/**
 * "I have arrived" (§8.3, §8.4, §17.2, §17.4). The technician reports arrival at a job that is EN_ROUTE; the server
 * compares the reported position with the service address (straight-line distance against the address radius, else the
 * tenant default) and records the verdict WITH its accuracy, distance and radius. The job always moves to ARRIVED
 * through the jobs lifecycle: a technician standing at the door must not be blocked by a bad GPS fix.
 *
 *  - inside the radius with a usable accuracy: a RECORDED arrival, a candidate verification, shown as "reported", not proof;
 *  - outside, too vague, no position, or an address without coordinates: PENDING_MANAGER_REVIEW with an exception, and the
 *    managers with `location.approve` over the job's unit are notified.
 *
 * Authorization: `location.create` for the caller's OWN record and a job assigned to the caller (else 404).
 * Offline: `clientEventId` makes it idempotent; `occurredAt` is when the technician arrived. The response never holds coordinates.
 */

/** Statuses from which the job can still reach EN_ROUTE, so a refused arrival may be retried after the earlier event synced. */
const CAN_STILL_REACH_EN_ROUTE: readonly string[] = ["ASSIGNED", "SCHEDULED", "RESCHEDULED"];

export interface ArrivalResult {
  arrival: Record<string, unknown>;
  job: { id: string; status: string };
}

async function viewArrival(tx: TenantTx, actor: EmployeeActor, jobId: string, arrivalId: string): Promise<ArrivalResult> {
  const decision = await enforceInTx(tx, actor, "location.create", { employeeId: actor.employeeId, ownerEmployeeId: actor.employeeId });
  const row = await tx.arrivalVerification.findFirst({ where: { id: arrivalId, jobId, tenantId: actor.tenantId }, select: arrivalSelect });
  const job = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: { id: true, status: true } });
  if (!row || !job) throw new NotFoundError();
  return { arrival: projectFields(arrivalView(row), decision, ARRIVAL_FIELD_MAP), job };
}

export async function confirmArrival(actor: Actor, ctx: RequestContext, jobId: string, input: ArriveInput): Promise<ArrivalResult & { replayed: boolean }> {
  const self = requireEmployee(actor);
  const now = new Date();
  // The two device clocks must tell the same story, else one of them is wrong and we cannot say which.
  if (input.occurredAt && input.position && Math.abs(input.occurredAt.getTime() - input.position.deviceTime.getTime()) > MAX_CLOCK_SKEW_MS) {
    throw new ValidationError({ message: "occurredAt and the position's device time disagree.", field: "occurredAt" });
  }
  const reportedAt = eventTime(input.occurredAt ?? input.position?.deviceTime, now);
  const notificationIds: string[] = [];

  const apply = async (tx: TenantTx, fieldEventId: string | undefined) => {
    const job = await loadJobForChange(tx, actor.tenantId, jobId); // locks: two submissions queue up here
    await enforceInTx(tx, self, "location.create", { employeeId: self.employeeId, ownerEmployeeId: self.employeeId });
    await assignedJobRef(tx, self, jobId);
    if (job.status !== "EN_ROUTE") {
      // retryable only while the job can still become EN_ROUTE (the earlier event may not have synced yet); from a terminal or later state a retry cannot help, so the verdict is stored.
      throw new InvalidStateTransitionError({ message: `Arrival can only be confirmed while the job is EN_ROUTE (it is ${job.status}).`, retryable: CAN_STILL_REACH_EN_ROUTE.includes(job.status) });
    }
    // Arrival cannot predate the moment the job went EN_ROUTE (statusChangedAt is that moment: the job is EN_ROUTE now).
    const { statusChangedAt: enRouteAt } = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId: actor.tenantId }, select: { statusChangedAt: true } });
    const arrivedAt = enRouteAt > reportedAt ? enRouteAt : reportedAt;

    const address = await tx.job.findFirstOrThrow({
      where: { id: jobId, tenantId: actor.tenantId },
      select: { serviceAddress: { select: { latitude: true, longitude: true, geofenceRadiusM: true } } },
    });
    const settings = await loadLocationSettings(tx, actor.tenantId);
    const radiusM = address.serviceAddress.geofenceRadiusM ?? settings.arrivalGeofenceRadiusM;
    const judgement = judgeArrival({
      position: input.position ?? null,
      address: { latitude: address.serviceAddress.latitude === null ? null : Number(address.serviceAddress.latitude), longitude: address.serviceAddress.longitude === null ? null : Number(address.serviceAddress.longitude) },
      radiusM,
      maxAccuracyM: settings.locationMaxAccuracyM,
    });

    // What the manager sees as the exception: the technician's own words when there was no position, else what the server measured.
    const reason = judgement.reviewReason;
    const exception =
      reason === null ? input.exception : reason === "NO_POSITION" && input.exception ? input.exception : { code: exceptionForReviewReason(reason), note: reason === "ADDRESS_WITHOUT_COORDINATES" ? "The job address has no coordinates to compare with." : undefined };
    const shift = await tx.shift.findFirst({ where: { tenantId: actor.tenantId, employeeId: self.employeeId, status: "ACTIVE" }, select: { id: true } });

    const event = await recordLocationEventInTx(
      tx,
      {
        tenantId: actor.tenantId,
        employeeId: self.employeeId,
        kind: "ARRIVAL",
        source: input.trigger === "GEOFENCE" ? "GEOFENCE" : input.position ? "DEVICE_GPS" : "MANUAL",
        position: input.position,
        deviceTime: input.position?.deviceTime ?? reportedAt,
        jobId,
        shiftId: shift?.id,
        deviceId: input.deviceId,
        exception: exception?.code,
        exceptionNote: exception?.note,
        distance: judgement.distanceM === null ? undefined : { distanceToJobM: judgement.distanceM, geofenceRadiusM: radiusM },
        verification: judgement.verification,
        fieldEventId,
      },
      now,
    );

    const arrival = await tx.arrivalVerification.create({
      data: {
        tenantId: actor.tenantId,
        jobId,
        employeeId: self.employeeId,
        shiftId: shift?.id,
        method: input.trigger === "GEOFENCE" ? "GEOFENCE" : "TECHNICIAN",
        status: reason ? "PENDING_MANAGER_REVIEW" : "RECORDED",
        arrivedAt,
        recordedAt: now,
        locationEventId: event.id,
        accuracyM: event.accuracyM,
        distanceToJobM: judgement.distanceM,
        geofenceRadiusM: judgement.distanceM === null ? null : radiusM,
        exceptionReason: reason ? exception?.code : null,
        exceptionNote: reason ? exception?.note : null,
        fieldEventId,
      },
      select: { id: true },
    });

    const audit = auditContextFields(ctx);
    await changeJobStatus(tx, actor, audit, job, "ARRIVED");
    await recordJobEvent(tx, actor.tenantId, jobId, {
      type: "job.arrival_recorded",
      actor,
      payload: { arrivalId: arrival.id, method: input.trigger, needsReview: reason !== null, verification: judgement.verification, distanceToJobM: judgement.distanceM, accuracyM: event.accuracyM },
    });
    await recordAudit(tx, {
      ...audit,
      action: "arrival.record",
      targetType: "ArrivalVerification",
      targetId: arrival.id,
      newValue: withoutCoordinates({ jobId, status: reason ? "PENDING_MANAGER_REVIEW" : "RECORDED", verification: judgement.verification, distanceToJobM: judgement.distanceM, accuracyM: event.accuracyM, reviewReason: reason }),
    });
    if (reason) notificationIds.push(...(await notifyArrivalNeedsReview(tx, actor, job, arrival.id)));
    return { result: await viewArrival(tx, self, jobId, arrival.id), entity: { type: "ArrivalVerification", id: arrival.id } };
  };

  const outcome = await runOwnFieldWrite<ArrivalResult>({
    actor: self,
    jobId,
    type: "job.arrive",
    clientEventId: input.clientEventId,
    occurredAt: reportedAt,
    deviceId: input.deviceId,
    // What the event MEANS as sent. Coordinates are hashed (one-way): a changed position under a reused id is a CONFLICT.
    payloadHash: hashFieldEventContent({ type: "job.arrive", jobId, trigger: input.trigger, occurredAt: input.occurredAt, position: input.position, exception: input.exception }),
    apply,
    replay: (tx, entity) => viewArrival(tx, self, jobId, entity.id),
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return { ...outcome.result, replayed: outcome.replayed };
}
