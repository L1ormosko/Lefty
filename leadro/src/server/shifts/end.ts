import { hashFieldEventContent } from "@/lib/location-rules";
import { reviewStateAfterBoundary } from "@/lib/shift-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { loadLocationSettings, recordLocationEventInTx, runFieldEvent } from "@/server/location";
import { assessBoundary, boundaryTime, lockEmployee } from "./boundary";
import { shiftResourceRef, shiftSelect } from "./fields";
import { readShiftInTx } from "./read";
import type { EndShiftInput } from "./schemas";

/**
 * Ends a shift (spec 8.1). Two callers:
 *  - the technician ends their OWN shift (`shifts.edit` over it; no `shiftId` = their current one), backed by a device
 *    position or a stated exception exactly like a start;
 *  - a manager ends or corrects SOMEONE ELSE's shift (`shifts.edit` over the employee's unit): `reason` is mandatory,
 *    no position is accepted (it is the manager's entry, not the device's), the shift records who did it and why
 *    (`endedByUserId`, `endReason`), and the location event is a MANAGER one.
 *
 * Idempotent: ending a shift that already ended returns it unchanged (`alreadyEnded: true`); with a `clientEventId`
 * a repeated delivery is answered from the first one. Ending is refused before the shift started.
 */

export interface EndShiftResult {
  shift: Record<string, unknown>;
  alreadyEnded: boolean;
  replayed: boolean;
}

/** An end repeated within this long after the server RECORDED it (not the device's `endedAt`, which may be hours old) gets the ended shift back (a retry after a lost response), not an error. */
const RETRY_WINDOW_MS = 5 * 60_000;

/** The shift to end: the named one, or the caller's own ACTIVE one (or one that ended just now, so a plain retry is idempotent). */
async function findShiftToEnd(tx: TenantTx, actor: Actor, shiftId: string | undefined) {
  if (shiftId) {
    const row = await tx.shift.findFirst({ where: { id: shiftId, tenantId: actor.tenantId }, select: shiftSelect });
    if (!row) throw new NotFoundError();
    return row;
  }
  const own = await tx.shift.findFirst({
    where: {
      tenantId: actor.tenantId,
      employeeId: actor.employeeId as string,
      OR: [{ status: "ACTIVE" }, { endRecordedAt: { gte: new Date(Date.now() - RETRY_WINDOW_MS) } }],
    },
    orderBy: [{ status: "asc" }, { startedAt: "desc" }], // ACTIVE sorts before ENDED
    select: shiftSelect,
  });
  if (!own) throw new InvalidStateTransitionError({ message: "There is no active shift to end." });
  return own;
}

export async function endShift(actor: Actor, ctx: RequestContext, shiftId: string | undefined, input: EndShiftInput): Promise<EndShiftResult> {
  if (!shiftId && !actor.employeeId) throw new ForbiddenError();
  const now = new Date();
  const endedAt = boundaryTime(input.occurredAt, now);

  const apply = async (tx: TenantTx, fieldEventId: string | undefined): Promise<{ result: EndShiftResult; shiftId: string; employeeId: string }> => {
    await enforceInTx(tx, actor, "shifts.edit");
    const found = await findShiftToEnd(tx, actor, shiftId);
    await enforceInTx(tx, actor, "shifts.edit", shiftResourceRef(found));
    await lockEmployee(tx, actor.tenantId, found.employeeId);
    // Re-read under the lock: a concurrent end must be seen, not overwritten.
    const shift = await tx.shift.findFirstOrThrow({ where: { id: found.id, tenantId: actor.tenantId }, select: shiftSelect });
    const byOther = shift.employeeId !== actor.employeeId;

    if (shift.status === "ENDED") {
      const { view } = await readShiftInTx(tx, actor, shift.id);
      return { result: { shift: view, alreadyEnded: true, replayed: false }, shiftId: shift.id, employeeId: shift.employeeId };
    }
    if (endedAt < shift.startedAt) throw new InvalidStateTransitionError({ message: "A shift cannot end before it started." });

    if (byOther && !input.reason) throw new ValidationError({ message: "Say why you are ending someone else's shift.", field: "reason" });
    if (byOther && (input.position || input.exception)) {
      throw new ValidationError({ message: "A manager's correction carries no device position; explain it in the reason.", field: "position" });
    }

    const settings = await loadLocationSettings(tx, actor.tenantId);
    // A technician's own end is backed by the device or a stated exception; a manager's correction by the reason alone.
    const assessment = byOther ? null : assessBoundary(input, settings.locationMaxAccuracyM, now.getTime() - endedAt.getTime());
    const event = await recordLocationEventInTx(
      tx,
      {
        tenantId: actor.tenantId,
        employeeId: shift.employeeId,
        shiftId: shift.id,
        orgUnitId: shift.orgUnitId,
        kind: "SHIFT_END",
        source: assessment ? assessment.source : "MANAGER",
        position: input.position,
        deviceTime: input.position?.deviceTime ?? null,
        deviceId: input.deviceId,
        exception: assessment?.exception?.code,
        exceptionNote: assessment?.exception?.note ?? undefined,
        recordedByUserId: byOther ? actor.userId : undefined,
        fieldEventId,
      },
      now,
    );
    await tx.shift.update({
      where: { id: shift.id },
      data: {
        status: "ENDED",
        endedAt,
        endRecordedAt: now,
        endLocationEventId: event.id,
        endException: assessment?.exception?.code,
        endExceptionNote: assessment?.exception?.note,
        endedByUserId: byOther ? actor.userId : undefined,
        endReason: byOther ? input.reason : undefined,
        ...(assessment?.reviewRequired
          ? { exceptionReviewStatus: reviewStateAfterBoundary(shift.exceptionReviewStatus, true), reviewedById: null, reviewedAt: null, reviewNote: null }
          : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: byOther ? "shift.end_by_manager" : "shift.end",
      targetType: "Shift",
      targetId: shift.id,
      previousValue: { status: "ACTIVE" },
      newValue: { status: "ENDED", endedAt: endedAt.toISOString(), source: event.source, accuracyM: event.accuracyM, exception: assessment?.exception?.code ?? null },
      reason: byOther ? input.reason : undefined,
    });
    const { view } = await readShiftInTx(tx, actor, shift.id);
    return { result: { shift: view, alreadyEnded: false, replayed: false }, shiftId: shift.id, employeeId: shift.employeeId };
  };

  if (!input.clientEventId) {
    return withTenant(actor.tenantId, async (tx) => (await apply(tx, undefined)).result);
  }
  // Offline idempotency is per employee, and only a technician's own device sends it (a manager's correction is online).
  if (!actor.employeeId) throw new ForbiddenError();
  const outcome = await runFieldEvent<EndShiftResult>(
    {
      tenantId: actor.tenantId,
      employeeId: actor.employeeId,
      actorUserId: actor.userId,
      type: "shift.end",
      clientEventId: input.clientEventId,
      occurredAt: endedAt,
      deviceId: input.deviceId,
      payloadHash: hashFieldEventContent({ type: "shift.end", shiftId, occurredAt: input.occurredAt, position: input.position, exception: input.exception, reason: input.reason }),
    },
    {
      apply: async (tx, fieldEventId) => {
        const { result, shiftId: endedShiftId, employeeId } = await apply(tx, fieldEventId);
        // The FieldEvent's shift FK is (shift, employee): only link it when the shift is the sender's own.
        return { result, entity: { type: "Shift", id: endedShiftId, shiftId: employeeId === actor.employeeId ? endedShiftId : undefined } };
      },
      replay: async (tx, entity) => ({ shift: (await readShiftInTx(tx, actor, entity.id)).view, alreadyEnded: false, replayed: true }),
    },
  );
  return { ...outcome.result, replayed: outcome.replayed };
}
