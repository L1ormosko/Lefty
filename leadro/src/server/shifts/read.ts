import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, fieldSetsForRow, projectFields, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { ForbiddenError, NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { SHIFT_FIELD_MAP, shiftAttributes, shiftResourceRef, shiftScopeColumns, shiftSelect, shiftView, type ShiftRow } from "./fields";
import type { ListShiftsQuery } from "./schemas";

/**
 * Shift reads. Every read needs `shifts.view` over the shift (a technician's OWN scope covers their shifts, a manager's
 * unit scope covers their people's); out-of-scope shifts are 404. Rows are projected per row to the grant that covers them.
 */

/** Loads one shift and checks `shifts.view` over it. Returns the row and the decision's projected view. */
export async function readShiftInTx(tx: TenantTx, actor: Actor, shiftId: string): Promise<{ row: ShiftRow; view: Record<string, unknown> }> {
  await enforceInTx(tx, actor, "shifts.view");
  const row = await tx.shift.findFirst({ where: { id: shiftId, tenantId: actor.tenantId }, select: shiftSelect });
  if (!row) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, "shifts.view", shiftResourceRef(row));
  return { row, view: projectFields(shiftView(row), decision, SHIFT_FIELD_MAP) };
}

export async function getShift(actor: Actor, shiftId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => (await readShiftInTx(tx, actor, shiftId)).view);
}

/** The caller's own ACTIVE shift, or null when they are off shift. Needs an employee profile. */
export async function getCurrentShift(actor: Actor): Promise<Record<string, unknown> | null> {
  if (!actor.employeeId) throw new ForbiddenError();
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "shifts.view");
    const row = await tx.shift.findFirst({ where: { tenantId: actor.tenantId, employeeId: actor.employeeId as string, status: "ACTIVE" }, select: shiftSelect });
    if (!row) return null;
    const decision = await enforceInTx(tx, actor, "shifts.view", shiftResourceRef(row));
    return projectFields(shiftView(row), decision, SHIFT_FIELD_MAP);
  });
}

/**
 * The resource reference of ONE shift, read from the database in the caller's transaction (null = no such shift:
 * routes answer 404). The `requirePermission` resolver for every `/shifts/{id}/...` route.
 */
export async function shiftRef(tx: TenantTx, tenantId: string, shiftId: string): Promise<ResourceRef | null> {
  const row = await tx.shift.findFirst({ where: { id: shiftId, tenantId }, select: shiftSelect });
  return row ? shiftResourceRef(row) : null;
}

/**
 * One page of shifts the caller may see, newest start first (`startedAt desc, id desc`): a technician's own history, a
 * manager's people. The data scope is part of the query; filters only narrow it.
 */
export async function listShifts(actor: Actor, query: ListShiftsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "shifts.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "shifts.view", now);
    const filters: Prisma.ShiftWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.orgUnitId ? { orgUnitId: query.orgUnitId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.exceptionReview ? { exceptionReviewStatus: query.exceptionReview } : {}),
      ...(query.from || query.to ? { startedAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
    };
    const rows = await tx.shift.findMany({
      where: withinScope(buildScopeWhere(scope, shiftScopeColumns, now), filters),
      select: shiftSelect,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = page.data.map((row) => projectFields(shiftView(row), { allowed: true, fieldSets: fieldSetsForRow(scope, shiftAttributes(row)) }, SHIFT_FIELD_MAP));
    return { data, page: page.page };
  });
}
