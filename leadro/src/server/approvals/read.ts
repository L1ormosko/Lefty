import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { approvalScopeColumns, evaluateRequestAccess, loadVisibleRequest, moneyVisibleTo, viewerFacts, type RequestAccess } from "./access";
import { approvalRequestRowSelect, approvalRequestView, type ApprovalRequestRow } from "./fields";
import type { ApprovalQueueQuery, ListApprovalsQuery, MyApprovalsQuery } from "./schemas";

/**
 * Reading requests. Every read needs `approvals.view`; what is listed follows the visibility rules in access.ts and is
 * filtered IN THE QUERY (never after loading a page), so a page can never hold someone else's request.
 */

/** One request, if the caller may see it (else 404). */
export async function getApprovalRequest(actor: Actor, requestId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const access = await loadVisibleRequest(tx, actor, requestId);
    return approvalRequestView(access.row, viewerFacts(access, actor.userId, new Date()), moneyVisibleTo(access));
  });
}

/**
 * The scope filter "requests whose approver permission I hold over their unit". Approver permissions differ per policy, so
 * the filter is an OR over the permissions that actually occur on pending requests, each with the caller's scope for it.
 */
async function approverWhere(tx: TenantTx, actor: Actor, now: Date): Promise<Prisma.ApprovalRequestWhereInput> {
  const permissions = await tx.approvalRequest.findMany({
    where: { tenantId: actor.tenantId, status: "PENDING" },
    distinct: ["approverPermission"],
    select: { approverPermission: true },
  });
  const parts: Prisma.ApprovalRequestWhereInput[] = [];
  for (const { approverPermission } of permissions) {
    const scope = await resolveScope(tx, actor, approverPermission, now);
    if (!scope.tenantWide && scope.parts.length === 0) continue;
    parts.push(withinScope(buildScopeWhere(scope, approvalScopeColumns, now), { approverPermission }));
  }
  // No permission covers anything: match nothing (fail closed).
  return parts.length > 0 ? { OR: parts } : { id: { in: [] } };
}

/** Builds the per-row view; the caller's access per row is evaluated with the same rules as a single read. */
async function viewRows(tx: TenantTx, actor: Actor, rows: ApprovalRequestRow[], now: Date): Promise<Record<string, unknown>[]> {
  // Many rows share a subject type, permission and unit; evaluate each combination once.
  const cache = new Map<string, Promise<RequestAccess>>();
  const views: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = `${row.subjectType}|${row.approverPermission}|${row.orgUnitId ?? ""}|${row.requestedById === actor.userId}`;
    let shared = cache.get(key);
    if (!shared) {
      shared = evaluateRequestAccess(tx, actor, row);
      cache.set(key, shared);
    }
    const access = { ...(await shared), row };
    views.push(approvalRequestView(row, viewerFacts(access, actor.userId, now), moneyVisibleTo(access)));
  }
  return views;
}

/**
 * The approver queue: PENDING, unexpired requests the caller can decide now (holds the approver permission over the scope,
 * is neither the requester nor excluded, has not decided yet). Oldest first, so nothing waits behind newer work.
 */
export async function listApprovalQueue(actor: Actor, query: ApprovalQueueQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "approvals.view");
    const now = new Date();
    const where: Prisma.ApprovalRequestWhereInput = withinScope(await approverWhere(tx, actor, now), {
      tenantId: actor.tenantId,
      status: "PENDING",
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        // `requestedById <> me` alone would drop system requests (NULL), so NULL is listed explicitly.
        { OR: [{ requestedById: null }, { requestedById: { not: actor.userId } }] },
        { NOT: { excludedApproverIds: { has: actor.userId } } },
        { decisions: { none: { deciderId: actor.userId } } },
        ...(query.subjectType ? [{ subjectType: query.subjectType }] : []),
      ],
    });
    const rows = await tx.approvalRequest.findMany({ where, select: approvalRequestRowSelect, orderBy: [{ requestedAt: "asc" }, { id: "asc" }], ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { data: await viewRows(tx, actor, page.data, now), page: page.page };
  });
}

/** The caller's own requests, newest first. */
export async function listMyApprovalRequests(actor: Actor, query: MyApprovalsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "approvals.view");
    const now = new Date();
    const rows = await tx.approvalRequest.findMany({
      where: {
        tenantId: actor.tenantId,
        requestedById: actor.userId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      },
      select: approvalRequestRowSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: await viewRows(tx, actor, page.data, now), page: page.page };
  });
}

/** Every request in the caller's `approvals.manage` scope (oversight), newest first. */
export async function listApprovalRequests(actor: Actor, query: ListApprovalsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "approvals.view");
    await enforceInTx(tx, actor, "approvals.manage");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "approvals.manage", now);
    const rows = await tx.approvalRequest.findMany({
      where: withinScope(buildScopeWhere(scope, approvalScopeColumns, now), {
        tenantId: actor.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.subjectType ? { subjectType: query.subjectType } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      }),
      select: approvalRequestRowSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: await viewRows(tx, actor, page.data, now), page: page.page };
  });
}
