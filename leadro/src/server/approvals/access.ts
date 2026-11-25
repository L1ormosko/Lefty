import type { Prisma } from "@prisma/client";
import { canInTx, enforceInTx, type AccessSubject, type ResourceRef, type ScopeColumns } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { approvalRequestRowSelect, type ApprovalRequestRow, type ApprovalViewerFacts } from "./fields";

/**
 * Who may see and act on an approval request (§21.3, PERMISSIONS.md section 11).
 *
 * Every approvals endpoint needs `approvals.view` (the capability, any scope). Beyond it, a request is visible to:
 *  - its requester (their own requests, wherever they are);
 *  - an ELIGIBLE APPROVER: someone holding the policy's `approverPermission` (snapshotted on the request) over the request's
 *    scope. Holding `approvals.view` alone never shows or decides anyone else's request;
 *  - an overseer: `approvals.manage` over the request's scope (sees and cancels, but not the amount, see fields.ts).
 * The request's scope is the org unit snapshotted from the subject when it was created (`orgUnitId`; null = tenant-level,
 * reached only by a TENANT scope). LEGAL_ENTITY scopes follow the unit's legal entity. Requests have no OWN / ASSIGNED
 * attribute, so those scopes reach none (the requester rule covers "my own").
 * A request the caller may not see is a 404, so its existence is not revealed.
 */

export const approvalScopeColumns: ScopeColumns<Prisma.ApprovalRequestWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { is: { legalEntityId: { in: legalEntityIds } } } }),
};

/** The authorization attributes of a request: its unit, or tenant-level. */
export const requestResource = (row: Pick<ApprovalRequestRow, "orgUnitId">): ResourceRef => (row.orgUnitId ? { orgUnitId: row.orgUnitId } : {});

export const loadRequestRow = (tx: TenantTx, tenantId: string, requestId: string): Promise<ApprovalRequestRow | null> =>
  tx.approvalRequest.findFirst({ where: { id: requestId, tenantId }, select: approvalRequestRowSelect });

/** Notification / route resolver: the scope attributes of one request, null when it does not exist. */
export async function approvalRequestResourceRefById(tx: TenantTx, tenantId: string, requestId: string): Promise<ResourceRef | null> {
  const row = await tx.approvalRequest.findFirst({ where: { id: requestId, tenantId }, select: { orgUnitId: true } });
  return row ? requestResource(row) : null;
}

/** Locks the request row so decisions, cancellation and expiry of one request are serialized. */
export async function lockRequest(tx: TenantTx, tenantId: string, requestId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ApprovalRequest" WHERE id = ${requestId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/** Is `subject` excluded from deciding by separation of duties (requester, or an editor / submitter of the subject)? */
export function isExcludedFromDeciding(row: Pick<ApprovalRequestRow, "requestedById" | "excludedApproverIds">, userId: string): boolean {
  return row.requestedById === userId || row.excludedApproverIds.includes(userId);
}

/** Does `subject` hold the request's approver permission over its scope (regardless of separation of duties)? */
export async function holdsApproverPermission(tx: TenantTx, subject: AccessSubject, row: Pick<ApprovalRequestRow, "approverPermission" | "orgUnitId">): Promise<boolean> {
  return (await canInTx(tx, subject, row.approverPermission, requestResource(row))).allowed;
}

export interface RequestAccess {
  row: ApprovalRequestRow;
  isRequester: boolean;
  isApprover: boolean;
  isOverseer: boolean;
}

/** The three ways of reaching a request, evaluated for `actor`. */
export async function evaluateRequestAccess(tx: TenantTx, actor: AccessSubject, row: ApprovalRequestRow): Promise<RequestAccess> {
  const isRequester = row.requestedById === actor.userId;
  const isApprover = await holdsApproverPermission(tx, actor, row);
  const isOverseer = (await canInTx(tx, actor, "approvals.manage", requestResource(row))).allowed;
  return { row, isRequester, isApprover, isOverseer };
}

/**
 * Loads a request the actor may see (`approvals.view` capability + requester / approver / overseer), else 404.
 * @throws ForbiddenError without `approvals.view`; NotFoundError for a missing or invisible request.
 */
export async function loadVisibleRequest(tx: TenantTx, actor: Actor, requestId: string): Promise<RequestAccess> {
  await enforceInTx(tx, actor, "approvals.view");
  const row = await loadRequestRow(tx, actor.tenantId, requestId);
  if (!row) throw new NotFoundError();
  const access = await evaluateRequestAccess(tx, actor, row);
  if (!access.isRequester && !access.isApprover && !access.isOverseer) throw new NotFoundError();
  return access;
}

/** What the viewer may do now. `now` decides expiry (an expired request can no longer be decided or cancelled). */
export function viewerFacts(access: RequestAccess, userId: string, now: Date): ApprovalViewerFacts {
  const { row } = access;
  const open = row.status === "PENDING" && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
  const mine = row.decisions.find((decision) => decision.deciderId === userId);
  return {
    isRequester: access.isRequester,
    canDecide: open && access.isApprover && !isExcludedFromDeciding(row, userId) && !mine,
    canCancel: open && (access.isRequester || access.isOverseer),
    myDecision: mine ? mine.decision : null,
  };
}

/** Amount, currency and details are shown to the requester and to holders of the approver permission (fields.ts). */
export const moneyVisibleTo = (access: RequestAccess): boolean => access.isRequester || access.isApprover;
