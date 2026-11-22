import { canTransitionQualification, type QualificationStatusValue } from "@/lib/qualification-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { assertBaseFields, toQualificationView, type QualificationView } from "./views";

/**
 * HR's decisions on a skill or credential (§10.1): verify, reject, revoke. Each needs
 * `qualifications.approve` over the employee (managers who record credentials do not hold it:
 * separation of duties, docs/PERMISSIONS.md), writes an audit event with the previous and new
 * status, and follows the status machine in `src/lib/qualification-lifecycle.ts`.
 */

type Decision = "VERIFIED" | "REJECTED" | "REVOKED";

const ACTIONS: Record<Decision, string> = {
  VERIFIED: "qualification.verify",
  REJECTED: "qualification.reject",
  REVOKED: "qualification.revoke",
};

async function decide(
  actor: Actor,
  ctx: RequestContext,
  qualificationId: string,
  target: Decision,
  reason: string | null,
): Promise<QualificationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.approve");
    const row = await tx.employeeQualification.findFirst({ where: { id: qualificationId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.approve", { employeeId: row.employeeId });
    assertBaseFields(decision);

    const employee = await tx.employee.findFirst({ where: { id: row.employeeId, tenantId: actor.tenantId }, select: { userId: true } });
    // §21.3 separation of duties: nobody vouches for their own credentials.
    if (employee?.userId === actor.userId || row.employeeId === actor.employeeId) {
      throw new ForbiddenError({ message: "You cannot verify, reject or revoke your own qualifications." });
    }
    if (!canTransitionQualification(row.status as QualificationStatusValue, target)) {
      throw new InvalidStateTransitionError({ message: `A ${row.status.toLowerCase().replace("_", " ")} qualification cannot become ${target.toLowerCase()}.` });
    }

    if (target === "VERIFIED") {
      if (row.certificationId) {
        const certification = await tx.certification.findFirst({ where: { id: row.certificationId, tenantId: actor.tenantId }, select: { requiresNumber: true } });
        if (certification?.requiresNumber && !row.number) {
          throw new ValidationError({ message: "This credential requires its number before it can be verified.", field: "number" });
        }
      }
      // Verifying something already past its date would only create a row that never counts.
      if (row.expiresAt && row.expiresAt.getTime() < Date.parse(new Date().toISOString().slice(0, 10))) {
        throw new ValidationError({ message: "This credential has already expired.", field: "expiresAt" });
      }
    }

    const now = new Date();
    const updated = await tx.employeeQualification.update({
      where: { id: row.id },
      data:
        target === "VERIFIED"
          ? { status: "VERIFIED", verifiedById: actor.userId, verifiedAt: now }
          : { status: target, verifiedById: null, verifiedAt: null },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: ACTIONS[target],
      targetType: "EmployeeQualification",
      targetId: row.id,
      previousValue: { status: row.status },
      newValue: { status: target },
      reason: reason ?? undefined,
    });
    return toQualificationView(updated);
  });
}

/** PENDING_VERIFICATION -> VERIFIED, recording who and when. */
export const verifyQualification = (actor: Actor, ctx: RequestContext, qualificationId: string) =>
  decide(actor, ctx, qualificationId, "VERIFIED", null);

/** PENDING_VERIFICATION -> REJECTED (reason required). The holder can correct and resubmit via an edit. */
export const rejectQualification = (actor: Actor, ctx: RequestContext, qualificationId: string, reason: string) =>
  decide(actor, ctx, qualificationId, "REJECTED", reason);

/** VERIFIED -> REVOKED (reason required): the issuing authority withdrew it, or it was found invalid. */
export const revokeQualification = (actor: Actor, ctx: RequestContext, qualificationId: string, reason: string) =>
  decide(actor, ctx, qualificationId, "REVOKED", reason);
