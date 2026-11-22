import type { AssignmentKind, Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  employeeScopeColumns,
  enforceInTx,
  narrowScopeToFieldSet,
  resolveScope,
  withinScope,
} from "@/server/authz";
import { ForbiddenError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";

/** One placement row of the organization-wide history screen (§3.4 "Organization History"). */
export interface PlacementHistoryEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  orgUnitId: string;
  kind: AssignmentKind;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string | null;
  /** Display name of whoever recorded the change (their employee name, else their login email). */
  recordedBy: string | null;
  /** For a PRIMARY row: the unit the person was in right before (null for a first placement). */
  previousOrgUnitId: string | null;
}

/**
 * Placement changes of every employee the caller may see, newest first: previous unit, new unit,
 * effective dates, who recorded it and why. Needs `employees.view` with the `base` field set; the
 * employee scope is part of the query, so paging cannot leak rows. Optionally limited to one unit.
 * Rows are never edited (see `employee-assignments.ts`), so this is the audit-grade record.
 */
export async function listPlacementHistory(
  actor: Actor,
  query: { cursor?: string; limit: number; orgUnitId?: string },
): Promise<Page<PlacementHistoryEntry>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "employees.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "employees.view", now), "base");
    // Same answer as `listEmployeeAssignments` for a grant without the base field set.
    if (scope.parts.length === 0) throw new ForbiddenError();
    const where: Prisma.OrganizationalAssignmentWhereInput = {
      tenantId: actor.tenantId,
      ...(query.orgUnitId ? { orgUnitId: query.orgUnitId } : {}),
      employee: withinScope(buildScopeWhere(scope, employeeScopeColumns, now), { tenantId: actor.tenantId }),
    };
    const rows = await tx.organizationalAssignment.findMany({
      where,
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      include: { employee: { select: { firstName: true, lastName: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);

    // "Previous unit" = the PRIMARY row right before this one, which may be on another page.
    const employeeIds = [...new Set(page.data.map((row) => row.employeeId))];
    const primaries = await tx.organizationalAssignment.findMany({
      where: { tenantId: actor.tenantId, employeeId: { in: employeeIds }, kind: "PRIMARY" },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
      select: { id: true, employeeId: true, orgUnitId: true },
    });
    const previousOf = new Map<string, string | null>();
    const lastByEmployee = new Map<string, string>();
    for (const row of primaries) {
      previousOf.set(row.id, lastByEmployee.get(row.employeeId) ?? null);
      lastByEmployee.set(row.employeeId, row.orgUnitId);
    }

    const recorderIds = [...new Set(page.data.map((row) => row.createdById).filter((id): id is string => id !== null))];
    const recorders = await tx.user.findMany({
      where: { tenantId: actor.tenantId, id: { in: recorderIds } },
      select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const recorderName = new Map(
      recorders.map((user) => [user.id, user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email]),
    );

    return {
      data: page.data.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
        orgUnitId: row.orgUnitId,
        kind: row.kind,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        reason: row.reason,
        recordedBy: row.createdById ? (recorderName.get(row.createdById) ?? null) : null,
        previousOrgUnitId: previousOf.get(row.id) ?? null,
      })),
      page: page.page,
    };
  });
}
