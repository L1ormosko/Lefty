import { activeAssignmentWhere, canInTx } from "@/server/authz";
import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver } from "@/server/notifications";
import { approvalRequestResourceRefById, isExcludedFromDeciding, requestResource } from "./access";
import type { ApprovalRequestRow } from "./fields";

/**
 * Approval notifications (§14.2, §21.3). Rows are written inside the business transaction; delivery happens after commit
 * (`deliverAfterCommit` by request-scoped callers, or the pending sweep).
 *
 * Who hears about a new request: every ACTIVE user who holds the request's `approverPermission` over its scope right now and
 * may decide it (not the requester, not an excluded editor / submitter). `notifyInTx` additionally drops recipients without
 * `approvals.view` over the request (the permission the linked page needs), so nobody is told about a request they cannot
 * open. The text carries no params: neither the subject nor the amount is in the notification.
 */

const TARGET_TYPE = "approval_request";
const TARGET_PERMISSION = "approvals.view";

/**
 * Read-time access for notifications that link to a request: the recipient's CURRENT `approvals.view` over the request's
 * scope decides (a revoked approver sees the generic "no longer available" row).
 */
export function registerApprovalNotificationTarget(): void {
  registerNotificationTargetResolver(TARGET_TYPE, TARGET_PERMISSION, (tx, subject, requestId) => approvalRequestResourceRefById(tx, subject.tenantId, requestId));
}
registerApprovalNotificationTarget();

/**
 * Users who may decide `row` right now: candidates are pre-selected in SQL (active user, active assignment of an active role
 * carrying the permission) and each is confirmed with `canInTx` over the request's scope, so scope rules have one
 * implementation. Works for tenant-level requests too (`{}` resource: TENANT scopes only).
 */
export async function resolveEligibleApprovers(tx: TenantTx, row: Pick<ApprovalRequestRow, "tenantId" | "approverPermission" | "orgUnitId" | "requestedById" | "excludedApproverIds">): Promise<string[]> {
  const candidates = await tx.user.findMany({
    where: {
      tenantId: row.tenantId,
      status: "ACTIVE",
      roleAssignments: {
        some: { ...activeAssignmentWhere(new Date()), role: { active: true, permissions: { some: { permission: { key: row.approverPermission } } } } },
      },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const resource = requestResource(row);
  const approvers: string[] = [];
  for (const { id } of candidates) {
    if (isExcludedFromDeciding(row, id)) continue;
    if ((await canInTx(tx, { tenantId: row.tenantId, userId: id }, row.approverPermission, resource)).allowed) approvers.push(id);
  }
  return approvers;
}

/** Tells the eligible approvers about a new request. Returns the created notification ids (for `deliverAfterCommit`). */
export async function notifyApprovers(tx: TenantTx, row: ApprovalRequestRow): Promise<string[]> {
  const recipients = await resolveEligibleApprovers(tx, row);
  if (recipients.length === 0) return [];
  const result = await notifyInTx(tx, {
    tenantId: row.tenantId,
    eventType: "approval.requested",
    eventId: row.id,
    recipientUserIds: recipients,
    target: { targetType: TARGET_TYPE, targetId: row.id, permission: TARGET_PERMISSION, resource: requestResource(row) },
  });
  return result.createdNotificationIds;
}

/** Tells the requester that the request ended (approved, rejected, expired, or cancelled by someone else). */
export async function notifyRequester(tx: TenantTx, row: Pick<ApprovalRequestRow, "id" | "tenantId" | "orgUnitId" | "requestedById">, actorUserId: string | null): Promise<string[]> {
  if (!row.requestedById || row.requestedById === actorUserId) return [];
  const result = await notifyInTx(tx, {
    tenantId: row.tenantId,
    eventType: "approval.decided",
    eventId: row.id,
    recipientUserIds: [row.requestedById],
    target: { targetType: TARGET_TYPE, targetId: row.id, permission: TARGET_PERMISSION, resource: requestResource(row) },
  });
  return result.createdNotificationIds;
}
