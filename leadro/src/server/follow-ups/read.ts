import type { Prisma } from "@prisma/client";
import { canInTx, enforceInTx, projectFields, withinScope } from "@/server/authz";
import { ValidationError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import {
  assertFollowUpAccess,
  canViewTarget,
  followUpResourceRef,
  loadFollowUpRow,
  resolveFollowUpListAccess,
} from "./access";
import { FOLLOW_UP_FIELD_MAP, followUpRowSelect, followUpView } from "./fields";
import { targetColumns } from "./targets";
import type { ListFollowUpsQuery } from "./schemas";

/** One follow-up inside the caller's transaction (both access gates). Outside the caller's reach it is a 404. */
export async function getFollowUpInTx(tx: TenantTx, actor: Actor, followUpId: string): Promise<Record<string, unknown>> {
  const { row, decision } = await assertFollowUpAccess(tx, actor, followUpId, "follow_ups.view");
  return projectFields(followUpView(row), decision, FOLLOW_UP_FIELD_MAP);
}

/**
 * The answer of a write: the task as the caller may see it. A writer who may not view the result (create without view)
 * gets only the id back, never a record they could not otherwise read.
 */
export async function viewAfterWrite(tx: TenantTx, actor: Actor, followUpId: string): Promise<Record<string, unknown>> {
  const row = await loadFollowUpRow(tx, actor.tenantId, followUpId);
  if (!row) return { id: followUpId };
  const decision = await canInTx(tx, actor, "follow_ups.view", followUpResourceRef(row));
  if (!decision.allowed || !(await canViewTarget(tx, actor, row))) return { id: followUpId };
  return projectFields(followUpView(row), decision, FOLLOW_UP_FIELD_MAP);
}

/** One follow-up. `follow_ups.view` over the task and view access to its target. */
export async function getFollowUp(actor: Actor, followUpId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, (tx) => getFollowUpInTx(tx, actor, followUpId));
}

/**
 * One page of follow-ups the caller may see: soonest due first (then id), so the top of the first page is the work that
 * needs doing now. Scope and target access are part of the query (`resolveFollowUpListAccess`); each row is projected
 * with the field sets of the grants covering THAT row.
 */
export async function listFollowUps(actor: Actor, query: ListFollowUpsQuery): Promise<Page<Record<string, unknown>>> {
  if (query.targetId && !query.targetType) {
    throw new ValidationError({ message: "targetId needs targetType.", field: "targetType" });
  }
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "follow_ups.view");
    const now = new Date();
    const access = await resolveFollowUpListAccess(tx, actor, "follow_ups.view", now);

    // "me" with no employee record matches nothing (a user without an employee is assigned nothing).
    const assigneeId = query.assigneeEmployeeId === "me" ? (actor.employeeId ?? "none") : query.assigneeEmployeeId;
    // Each filter is its own AND member so two filters on the same column narrow each other instead of overwriting.
    const filters: Prisma.FollowUpTaskWhereInput[] = [
      ...(query.status === "open" ? [{ status: { in: ["OPEN", "IN_PROGRESS"] as Array<"OPEN" | "IN_PROGRESS"> } }] : []),
      ...(query.status && query.status !== "open" ? [{ status: query.status }] : []),
      ...(query.priority ? [{ priority: query.priority }] : []),
      ...(query.targetType ? [{ targetType: query.targetType }] : []),
      ...(query.targetType && query.targetId ? [targetColumns(query.targetType, query.targetId)] : []),
      ...(assigneeId ? [{ assigneeId }] : []),
      ...(query.unassigned === "true" ? [{ assigneeId: null, status: { in: ["OPEN", "IN_PROGRESS"] as Array<"OPEN" | "IN_PROGRESS"> } }] : []),
      ...(query.unassigned === "false" ? [{ assigneeId: { not: null } }] : []),
      ...(query.overdue ? [{ status: { in: ["OPEN", "IN_PROGRESS"] as Array<"OPEN" | "IN_PROGRESS"> }, dueAt: { lt: now } }] : []),
      ...(query.dueFrom ? [{ dueAt: { gte: query.dueFrom } }] : []),
      ...(query.dueTo ? [{ dueAt: { lt: query.dueTo } }] : []),
      ...(query.orgUnitId ? [{ orgUnitId: query.orgUnitId }] : []),
    ];
    const rows = await tx.followUpTask.findMany({
      where: withinScope(access.where, { tenantId: actor.tenantId, AND: filters }),
      select: followUpRowSelect,
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = page.data.map((row) => projectFields(followUpView(row, now), { allowed: true, fieldSets: access.fieldSetsOf(row) }, FOLLOW_UP_FIELD_MAP));
    return { data, page: page.page };
  });
}
