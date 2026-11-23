import { auditContextFields, recordAudit } from "@/server/audit";
import { assertNotSelfApproval, enforceInTx, projectFields } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { SHIFT_FIELD_MAP, shiftResourceRef, shiftSelect, shiftView } from "./fields";
import type { ReviewShiftInput } from "./schemas";

/**
 * A manager's decision on a shift that was started or ended under an exception (GPS disabled, permission denied,
 * offline, a position too vague to count). Needs `shifts.approve` over the shift's unit. Only a PENDING review can be
 * decided, once; the decision, who, when and the mandatory note are stored on the shift (DB CHECK
 * `shift_exception_review`) and audited. Nobody reviews their own shift (separation of duties, spec 21.3).
 *
 * Deciding does not change the shift itself (its times stay as reported): it records whether the exception is accepted.
 *
 * @throws InvalidStateTransitionError when the shift has no exception or was already decided
 */
export async function reviewShiftException(actor: Actor, ctx: RequestContext, shiftId: string, input: ReviewShiftInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "shifts.approve");
    // Lock the row so two reviewers cannot both decide (the second sees the first's decision).
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Shift" WHERE id = ${shiftId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError();
    const shift = await tx.shift.findFirstOrThrow({ where: { id: shiftId, tenantId: actor.tenantId }, select: shiftSelect });
    const decision = await enforceInTx(tx, actor, "shifts.approve", shiftResourceRef(shift));
    assertNotSelfApproval(actor.userId, shift.employee.userId);

    if (shift.exceptionReviewStatus !== "PENDING") {
      throw new InvalidStateTransitionError({
        message: shift.exceptionReviewStatus === null ? "This shift has no exception to review." : "This exception was already reviewed.",
      });
    }
    const updated = await tx.shift.update({
      where: { id: shift.id },
      data: { exceptionReviewStatus: input.decision, reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: input.note },
      select: shiftSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "shift.exception_review",
      targetType: "Shift",
      targetId: shift.id,
      previousValue: { exceptionReviewStatus: "PENDING" },
      newValue: { exceptionReviewStatus: input.decision, startException: shift.startException, endException: shift.endException },
      reason: input.note,
    });
    return projectFields(shiftView(updated), decision, SHIFT_FIELD_MAP);
  });
}
