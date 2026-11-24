import { hashFieldEventContent } from "@/lib/location-rules";
import { reviewStateAfterBoundary } from "@/lib/shift-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { orgUnitAtInTx } from "@/server/employees";
import { runFieldEvent } from "@/server/field-events";
import { loadLocationSettings, recordLocationEventInTx, withoutCoordinates } from "@/server/location";
import { assessBoundary, boundaryTime, lockEmployee } from "./boundary";
import { readShiftInTx } from "./read";
import type { StartShiftInput } from "./schemas";

/**
 * Starts the caller's own shift (spec 8.1). Needs `shifts.create` for their own record; a person with no employee
 * profile cannot work shifts.
 *
 * Idempotent in two ways: (1) one ACTIVE shift per employee, so starting while a shift is running returns that shift
 * (`alreadyActive: true`) and records nothing; (2) with a `clientEventId` (offline, spec 8.7) a repeated delivery
 * answers with the original shift, and the same id with different content is `409`.
 *
 * The start is backed by a device position (with accuracy) or by an exception the technician states (GPS disabled,
 * permission denied, offline: a manual start with a reason). An exception, or a position too vague to be evidence,
 * leaves `exceptionReviewStatus = PENDING` for a manager (`shifts.approve`). Either way a SHIFT_START location event
 * is recorded in the same transaction, and the shift keeps a snapshot of the employee's org unit for manager scope.
 */

export interface StartShiftResult {
  shift: Record<string, unknown>;
  /** A shift was already running; nothing was created. */
  alreadyActive: boolean;
  /** A repeated clientEventId was answered from the first delivery. */
  replayed: boolean;
}

export async function startShift(actor: Actor, ctx: RequestContext, input: StartShiftInput): Promise<StartShiftResult> {
  if (!actor.employeeId) throw new ForbiddenError();
  const employeeId = actor.employeeId;
  const now = new Date();
  const startedAt = boundaryTime(input.occurredAt, now, input.clientEventId !== undefined);

  const apply = async (tx: TenantTx, fieldEventId: string | undefined): Promise<{ result: StartShiftResult; shiftId: string }> => {
    await enforceInTx(tx, actor, "shifts.create", { employeeId, ownerEmployeeId: employeeId });
    await lockEmployee(tx, actor.tenantId, employeeId);

    const running = await tx.shift.findFirst({ where: { tenantId: actor.tenantId, employeeId, status: "ACTIVE" }, select: { id: true } });
    if (running) {
      const { view } = await readShiftInTx(tx, actor, running.id);
      return { result: { shift: view, alreadyActive: true, replayed: false }, shiftId: running.id };
    }

    const employee = await tx.employee.findFirstOrThrow({ where: { id: employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (employee.status !== "ACTIVE") {
      throw new InvalidStateTransitionError({ message: "Only an active employee can start a shift." });
    }
    const previous = await tx.shift.findFirst({ where: { tenantId: actor.tenantId, employeeId }, orderBy: { endedAt: "desc" }, select: { endedAt: true } });
    if (previous?.endedAt && startedAt < previous.endedAt) {
      throw new InvalidStateTransitionError({ message: "This shift would start before the previous one ended." });
    }

    const settings = await loadLocationSettings(tx, actor.tenantId);
    const assessment = assessBoundary(input, settings.locationMaxAccuracyM, now.getTime() - startedAt.getTime());
    const orgUnitId = (await orgUnitAtInTx(tx, actor.tenantId, employeeId, startedAt))?.orgUnitId ?? null;

    const shift = await tx.shift.create({
      data: {
        tenantId: actor.tenantId,
        employeeId,
        orgUnitId,
        startedAt,
        startRecordedAt: now,
        deviceId: input.deviceId,
        startException: assessment.exception?.code,
        startExceptionNote: assessment.exception?.note,
        exceptionReviewStatus: reviewStateAfterBoundary(null, assessment.reviewRequired),
      },
      select: { id: true },
    });
    const event = await recordLocationEventInTx(
      tx,
      {
        tenantId: actor.tenantId,
        employeeId,
        shiftId: shift.id,
        orgUnitId,
        kind: "SHIFT_START",
        source: assessment.source,
        position: input.position,
        deviceTime: input.position?.deviceTime ?? null,
        deviceId: input.deviceId,
        exception: assessment.exception?.code,
        exceptionNote: assessment.exception?.note ?? undefined,
        fieldEventId,
      },
      now,
    );
    await tx.shift.update({ where: { id: shift.id }, data: { startLocationEventId: event.id } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "shift.start",
      targetType: "Shift",
      targetId: shift.id,
      // §22.2: ids, codes and accuracy only; coordinates stay in LocationEvent.
      newValue: withoutCoordinates({ employeeId, orgUnitId, startedAt: startedAt.toISOString(), source: event.source, accuracyM: event.accuracyM, exception: assessment.exception?.code ?? null }),
    });
    const { view } = await readShiftInTx(tx, actor, shift.id);
    return { result: { shift: view, alreadyActive: false, replayed: false }, shiftId: shift.id };
  };

  if (!input.clientEventId) {
    return withTenant(actor.tenantId, async (tx) => (await apply(tx, undefined)).result);
  }
  const outcome = await runFieldEvent<StartShiftResult>(
    {
      tenantId: actor.tenantId,
      employeeId,
      actorUserId: actor.userId,
      type: "shift.start",
      clientEventId: input.clientEventId,
      occurredAt: startedAt,
      deviceId: input.deviceId,
      // Hash what the device sent (a defaulted occurredAt is not part of it); coordinates are hashed one-way, never stored.
      payloadHash: hashFieldEventContent({ type: "shift.start", occurredAt: input.occurredAt, position: input.position, exception: input.exception }),
    },
    {
      apply: async (tx, fieldEventId) => {
        const { result, shiftId } = await apply(tx, fieldEventId);
        return { result, entity: { type: "Shift", id: shiftId, shiftId } };
      },
      replay: async (tx, entity) => ({ shift: (await readShiftInTx(tx, actor, entity.id)).view, alreadyActive: false, replayed: true }),
    },
  );
  return { ...outcome.result, replayed: outcome.replayed };
}
