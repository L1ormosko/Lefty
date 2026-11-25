import { recordAudit } from "@/server/audit";
import { ConflictError, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { systemAuditFields } from "./audit-fields";
import { approvalRequestRowSelect, type ApprovalRequestRow } from "./fields";
import { notifyRequester } from "./notify";
import { approvalSubjectHandler, type ApprovalOutcome } from "./registry";

/**
 * Ends a PENDING request (the caller holds the row lock and has re-read it): sets the final status with its timestamps,
 * calls the subject handler in the same transaction, audits, and notifies the requester. Shared by decide, cancel and the
 * expiry sweep so the three endings cannot drift apart.
 *
 * Fail closed: when the subject type has no registered handler the request cannot end (409), because the subject would
 * be left waiting while the request says it is decided.
 * @returns the updated row and the notification ids to deliver after commit.
 */
export async function finishRequestInTx(
  tx: TenantTx,
  ctx: RequestContext | null,
  row: ApprovalRequestRow,
  ending: { outcome: ApprovalOutcome; reason: string | null; now: Date },
): Promise<{ row: ApprovalRequestRow; notificationIds: string[] }> {
  const handler = approvalSubjectHandler(row.subjectType);
  if (!handler) throw new ConflictError({ message: `Approval requests for ${row.subjectType} cannot be completed: the subject is not available.` });
  const actorUserId = ctx?.actor?.userId ?? null;
  const { outcome, reason, now } = ending;

  const data =
    outcome === "APPROVED" || outcome === "REJECTED"
      ? { status: outcome, decidedAt: now }
      : outcome === "CANCELLED"
        ? { status: outcome, cancelledAt: now, cancelledById: actorUserId, cancelReason: reason }
        : { status: outcome };
  // The status guard in the WHERE makes the change conditional on the row still being PENDING (the lock already ensures it).
  const claim = await tx.approvalRequest.updateMany({ where: { id: row.id, tenantId: row.tenantId, status: "PENDING" }, data });
  if (claim.count !== 1) throw new ConflictError({ message: "The approval request changed at the same time. Reload and try again." });
  const updated = await tx.approvalRequest.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId }, select: approvalRequestRowSelect });

  const event = {
    tenantId: row.tenantId,
    requestId: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcome,
    actorUserId,
    approverIds: updated.decisions.filter((decision) => decision.decision === "APPROVE").map((decision) => decision.deciderId),
    reason,
    ctx,
    now,
  };
  if (outcome === "APPROVED") await handler.onApproved(tx, event);
  else await handler.onRejected(tx, event);

  await recordAudit(tx, {
    ...systemAuditFields(row.tenantId, ctx),
    action: `approval_request.${outcome.toLowerCase()}`,
    targetType: "ApprovalRequest",
    targetId: row.id,
    previousValue: { status: "PENDING" },
    newValue: {
      status: outcome,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      policyCode: row.policyCode,
      policyVersion: row.policyVersion,
      approverIds: event.approverIds,
    },
    reason: reason ?? undefined,
  });
  const notificationIds = await notifyRequester(tx, updated, actorUserId);
  return { row: updated, notificationIds };
}
