import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver, resolveRecipientsByPermission } from "@/server/notifications";
import { caseResourceRef, canViewCase } from "./access";

/**
 * Recovery notifications (§14.2). The audience of "a new case needs an owner" is Lead Operations over the case's service area:
 * the people who may ASSIGN recovery cases there, widening to those who may VIEW them when nobody can assign (a case never
 * waits unseen). Rows are written inside the business transaction; delivery to channels happens after commit (the pending
 * notification sweep `deliverPendingForAllTenants`, or `deliverAfterCommit` from request-scoped callers).
 */

/** Read-time access for notifications that link to a case: the recipient's CURRENT `recovery.view` over the case decides. */
export function registerRecoveryNotificationTarget(): void {
  registerNotificationTargetResolver("recovery_case", "recovery.view", async (tx, subject, caseId) => {
    const row = await tx.leadRecoveryCase.findFirst({ where: { id: caseId, tenantId: subject.tenantId }, select: { orgUnitId: true, assignedToId: true } });
    return row ? caseResourceRef(row) : null;
  });
}
registerRecoveryNotificationTarget();

/** Lead Operations hear about a new case. Returns how many notifications were created (0 = nobody to tell, or already told). */
export async function notifyCaseCreated(
  tx: TenantTx,
  tenantId: string,
  input: { caseId: string; caseNumber: number; orgUnitId: string; ruleId: string },
): Promise<number> {
  let recipients = await resolveRecipientsByPermission(tx, tenantId, { permissions: ["recovery.assign"], orgUnitId: input.orgUnitId });
  if (recipients.length === 0) recipients = await resolveRecipientsByPermission(tx, tenantId, { permissions: ["recovery.view"], orgUnitId: input.orgUnitId });
  if (recipients.length === 0) return 0;
  const result = await notifyInTx(tx, {
    tenantId,
    eventType: "recovery.case_created",
    eventId: `${input.caseId}:${input.ruleId}`,
    recipientUserIds: recipients,
    params: { caseNumber: input.caseNumber },
    target: { targetType: "recovery_case", targetId: input.caseId, permission: "recovery.view", resource: { orgUnitId: input.orgUnitId, assignedEmployeeIds: [] } },
  });
  return result.createdNotificationIds.length;
}

/** The new owner hears that a case is theirs. Returns the created notification ids (for `deliverAfterCommit`). */
export async function notifyCaseAssigned(
  tx: TenantTx,
  tenantId: string,
  input: { caseId: string; caseNumber: number; employeeId: string; excludeUserId?: string | null; anchor: string },
): Promise<string[]> {
  const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId }, select: { userId: true } });
  const userId = employee?.userId;
  if (!userId || userId === input.excludeUserId) return [];
  if (!(await canViewCase(tx, { tenantId, userId }, input.caseId))) return [];
  const row = await tx.leadRecoveryCase.findFirst({ where: { id: input.caseId, tenantId }, select: { orgUnitId: true, assignedToId: true } });
  if (!row) return [];
  const result = await notifyInTx(tx, {
    tenantId,
    eventType: "recovery.case_assigned",
    eventId: `${input.caseId}:${input.anchor}`,
    recipientUserIds: [userId],
    params: { caseNumber: input.caseNumber },
    target: { targetType: "recovery_case", targetId: input.caseId, permission: "recovery.view", resource: caseResourceRef(row) },
  });
  return result.createdNotificationIds;
}
