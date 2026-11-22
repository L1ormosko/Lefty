import { auditContextFields, recordAudit } from "@/server/audit";
import {
  EMPLOYEE_FIELD_MAP,
  employeeRowAttributes,
  employeeScopeSelect,
  enforceInTx,
  openEndedWhere,
  projectRows,
  resolveScope,
} from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import { assertActive } from "./org-unit-rules";
import type { AssignManagerInput } from "./schemas";

/**
 * Managers of an org unit (§3.3): many employees may manage one unit and one employee may manage
 * several units. Assignments are time-bounded and never deleted (ending one sets `effectiveTo`).
 *
 * Managing a unit does NOT grant data access: access comes only from role assignments and their
 * scopes (authz). This table answers "who is responsible for this unit" for people and reporting.
 */

/** A manager assignment as returned by the API; the employee name only when the caller may see it. */
export interface UnitManagerView {
  id: string;
  orgUnitId: string;
  employeeId: string;
  isPrimary: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  employee: { firstName?: string; lastName?: string } | null;
}

/**
 * Makes `employeeId` a manager of the unit, effective now. Needs `organization.assign` over the unit
 * and `employees.view` over the employee (so ids of employees you cannot see are not confirmed).
 * The unit must be active and the employee not terminated; a duplicate open assignment is a
 * conflict. With `isPrimary`, any other primary manager of the unit is demoted in the same
 * transaction (a unit has at most one primary manager).
 */
export async function assignUnitManager(
  actor: Actor,
  ctx: RequestContext,
  unitId: string,
  input: AssignManagerInput,
): Promise<Omit<UnitManagerView, "employee">> {
  return withTenant(actor.tenantId, async (tx) => {
    // Serialise manager changes of one unit so the duplicate / single-primary checks cannot race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-manager:${unitId}`}))`;
    await enforceInTx(tx, actor, "organization.assign", { orgUnitId: unitId });
    await enforceInTx(tx, actor, "employees.view", { employeeId: input.employeeId });

    const [unit, employee] = await Promise.all([
      tx.orgUnit.findFirst({ where: { id: unitId, tenantId: actor.tenantId }, select: { active: true } }),
      tx.employee.findFirst({ where: { id: input.employeeId, tenantId: actor.tenantId }, select: { status: true } }),
    ]);
    if (!unit || !employee) throw new NotFoundError();
    assertActive(unit, "An archived unit cannot get a new manager.");
    if (employee.status === "TERMINATED") {
      throw new InvalidStateTransitionError({ message: "A terminated employee cannot manage a unit." });
    }

    const now = new Date();
    const duplicate = await tx.orgUnitManager.findFirst({
      where: { tenantId: actor.tenantId, orgUnitId: unitId, employeeId: input.employeeId, ...openEndedWhere(now) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError({ message: "This employee already manages the unit." });

    let demoted = 0;
    if (input.isPrimary) {
      ({ count: demoted } = await tx.orgUnitManager.updateMany({
        where: { tenantId: actor.tenantId, orgUnitId: unitId, isPrimary: true, ...openEndedWhere(now) },
        data: { isPrimary: false },
      }));
    }
    const manager = await tx.orgUnitManager.create({
      data: {
        tenantId: actor.tenantId,
        orgUnitId: unitId,
        employeeId: input.employeeId,
        isPrimary: input.isPrimary,
        effectiveFrom: now,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "org_unit.manager_assign",
      targetType: "OrgUnit",
      targetId: unitId,
      newValue: { managerId: manager.id, employeeId: input.employeeId, isPrimary: input.isPrimary, demotedPrimaryManagers: demoted },
    });
    return {
      id: manager.id,
      orgUnitId: manager.orgUnitId,
      employeeId: manager.employeeId,
      isPrimary: manager.isPrimary,
      effectiveFrom: manager.effectiveFrom,
      effectiveTo: manager.effectiveTo,
    };
  });
}

/**
 * Ends a manager assignment (effective now; the row is kept as history). Needs
 * `organization.assign` over the unit. Ending one that already ended is a state error.
 */
export async function unassignUnitManager(
  actor: Actor,
  ctx: RequestContext,
  unitId: string,
  managerId: string,
): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-manager:${unitId}`}))`;
    await enforceInTx(tx, actor, "organization.assign", { orgUnitId: unitId });
    const manager = await tx.orgUnitManager.findFirst({
      where: { id: managerId, tenantId: actor.tenantId, orgUnitId: unitId },
    });
    if (!manager) throw new NotFoundError();

    const now = new Date();
    if (manager.effectiveTo !== null && manager.effectiveTo <= now) {
      throw new InvalidStateTransitionError({ message: "This manager assignment has already ended." });
    }
    // The DB requires effectiveTo > effectiveFrom, hence the +1 ms guard for same-instant changes.
    const endsAt = manager.effectiveFrom >= now ? new Date(manager.effectiveFrom.getTime() + 1) : now;
    await tx.orgUnitManager.update({ where: { id: manager.id }, data: { effectiveTo: endsAt } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "org_unit.manager_unassign",
      targetType: "OrgUnit",
      targetId: unitId,
      previousValue: { managerId: manager.id, employeeId: manager.employeeId, isPrimary: manager.isPrimary },
      newValue: { effectiveTo: endsAt.toISOString() },
    });
  });
}

/**
 * Managers of a unit, current ones first (`organization.view` over the unit). A manager's name is
 * included only when the caller also holds `employees.view` over that employee; the employee
 * record is projected with the field sets of the caller's matching scope.
 */
export async function listUnitManagers(
  actor: Actor,
  unitId: string,
  query: { cursor?: string; limit: number; includeEnded?: boolean },
): Promise<Page<UnitManagerView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "organization.view", { orgUnitId: unitId });
    const now = new Date();
    const rows = await tx.orgUnitManager.findMany({
      where: { tenantId: actor.tenantId, orgUnitId: unitId, ...(query.includeEnded ? {} : openEndedWhere(now)) },
      orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }],
      select: {
        id: true,
        orgUnitId: true,
        employeeId: true,
        isPrimary: true,
        effectiveFrom: true,
        effectiveTo: true,
        employee: { select: { ...employeeScopeSelect(now), firstName: true, lastName: true } },
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);

    // A caller without employees.view gets an empty scope, so every name is hidden.
    const employeeScope = await resolveScope(tx, actor, "employees.view", now);
    const visible = projectRows(
      page.data.map((row) => ({ ...row.employee })),
      employeeScope,
      EMPLOYEE_FIELD_MAP,
      (employee) => employeeRowAttributes(employee),
    );
    const data: UnitManagerView[] = page.data.map((row, index) => {
      const fields = visible[index];
      const mayName = fields.firstName !== undefined;
      return {
        id: row.id,
        orgUnitId: row.orgUnitId,
        employeeId: row.employeeId,
        isPrimary: row.isPrimary,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        employee: mayName ? { firstName: fields.firstName, lastName: fields.lastName } : null,
      };
    });
    return { data, page: page.page };
  });
}
