import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { revokeAllSessionsForUser } from "@/server/auth";
import {
  assertMayDisableUser,
  buildScopeWhere,
  canInTx,
  employeeRowAttributes,
  employeeScopeColumns,
  enforceInTx,
  projectFields,
  projectRows,
  resolveScope,
  withinScope,
  type AccessDecision,
} from "@/server/authz";
import {
  conflictOnUniqueViolation,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  ValidationError,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assertLegalEntityUsable } from "@/server/organization";
import { effectiveAt, endInstant } from "./active-window";
import { EMPLOYEE_API_FIELD_MAP, employeeSelect, withDerivedFields, type EmployeeRow } from "./fields";
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  TerminateEmployeeInput,
  UpdateEmployeeInput,
} from "./schemas";

/**
 * Employee records (§3.4). A write needs the permission over the employee's data scope AND a grant
 * that covers the `base` field set (a field-limited grant, e.g. availability-only, may read but
 * must not change the record). Everything is audited in the same transaction.
 *
 * "Legal employer" (`legalEntityId`) and "operational team" (the PRIMARY placement) are separate
 * on purpose: see `employee-assignments.ts` for placements and their history.
 */

const DUPLICATE_NUMBER = "An employee with this employee number already exists.";

/** Changing employee data needs the plain `base` field set, not just any (limited) grant. */
function assertMayChangeBaseFields(decision: AccessDecision): void {
  if (!decision.fieldSets.includes("base")) throw new ForbiddenError();
}

/** Locks the unit row so a concurrent archive cannot slip between "is it active?" and our insert. */
export async function lockUnitShared(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<{ active: boolean } | null> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM "OrgUnit" WHERE id = ${orgUnitId} AND "tenantId" = ${tenantId} FOR SHARE`;
  return rows[0] ?? null;
}

/**
 * Creates an employee and, when `orgUnitId` is given, their first PRIMARY placement (effective now).
 * Needs `employees.create` over that unit; without a unit the employee is unplaced and a tenant-wide
 * grant is required. The unit must be active and the legal entity usable.
 */
export async function createEmployee(
  actor: Actor,
  ctx: RequestContext,
  input: CreateEmployeeInput,
): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation(DUPLICATE_NUMBER, () =>
    withTenant(actor.tenantId, async (tx) => {
      const orgUnitId = input.orgUnitId ?? null;
      const decision = await enforceInTx(tx, actor, "employees.create", orgUnitId ? { orgUnitId } : {});
      assertMayChangeBaseFields(decision);

      if (orgUnitId) {
        const unit = await lockUnitShared(tx, actor.tenantId, orgUnitId);
        if (!unit) throw new NotFoundError();
        if (!unit.active) throw new InvalidStateTransitionError({ message: "Employees cannot be placed in an archived unit." });
      }
      await assertLegalEntityUsable(tx, actor.tenantId, input.legalEntityId);
      // The legal employer is part of the data scope (LEGAL_ENTITY scopes): a unit-scoped creator
      // must not file a record under an employer outside their scope.
      if (input.legalEntityId) await enforceInTx(tx, actor, "employees.create", { legalEntityId: input.legalEntityId });
      if (input.hireDate && input.hireDate.getTime() > Date.now() + 366 * 86_400_000) {
        throw new ValidationError({ message: "The hire date is too far in the future.", field: "hireDate" });
      }

      const now = new Date();
      const employee = await tx.employee.create({
        data: {
          tenantId: actor.tenantId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          jobTitle: input.jobTitle,
          employeeNumber: input.employeeNumber,
          legalEntityId: input.legalEntityId,
          hireDate: input.hireDate,
          assignments: orgUnitId
            ? { create: { orgUnitId, kind: "PRIMARY", effectiveFrom: now, createdById: actor.userId, reason: "Initial placement" } }
            : undefined,
        },
        select: employeeSelect(now),
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "employee.create",
        targetType: "Employee",
        targetId: employee.id,
        newValue: { ...input, orgUnitId },
      });
      return projectForViewer(tx, actor, employee, decision);
    }),
  );
}

/**
 * What the caller may SEE of an employee as it is now (after a write): the `employees.view` decision
 * on the post-change record, not the write grant's. A write can move a record into another scope
 * (e.g. a different legal employer), and the response must not reveal fields the caller's view
 * grants do not cover for it. Falls back to `{ id }` when the caller may no longer view it.
 */
async function projectForViewer(
  tx: TenantTx,
  actor: Actor,
  row: EmployeeRow,
  writeDecision: AccessDecision,
): Promise<Record<string, unknown>> {
  const view = await canInTx(tx, actor, "employees.view", { employeeId: row.id });
  if (!view.allowed) return { id: row.id };
  // Only fields BOTH grants cover: the response is never wider than what the caller could write or view.
  const shared = view.fieldSets.filter((set) => writeDecision.fieldSets.includes(set) || set === "base");
  return projectFields(withDerivedFields(row), { allowed: true, fieldSets: shared }, EMPLOYEE_API_FIELD_MAP);
}

/**
 * Edits an employee's data (name, contact, job title, number, legal employer, hire date) or toggles
 * ACTIVE / ON_LEAVE. Needs `employees.edit` over the employee with the `base` field set. A
 * terminated employee is read-only (history must not be rewritten).
 */
export async function updateEmployee(
  actor: Actor,
  ctx: RequestContext,
  employeeId: string,
  input: UpdateEmployeeInput,
): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation(DUPLICATE_NUMBER, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "employees.edit", { employeeId });
      assertMayChangeBaseFields(decision);

      const now = new Date();
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, tenantId: actor.tenantId },
        select: employeeSelect(now),
      });
      if (!employee) throw new NotFoundError();
      if (employee.status === "TERMINATED") {
        throw new InvalidStateTransitionError({ message: "A terminated employee cannot be edited." });
      }

      const { changedKeys, previous, next } = changedFields(employee, input);
      if (changedKeys.length === 0) return projectFields(withDerivedFields(employee), decision, EMPLOYEE_API_FIELD_MAP);
      if (input.legalEntityId !== undefined) await assertLegalEntityUsable(tx, actor.tenantId, input.legalEntityId);
      // Re-pointing the legal employer moves the record between LEGAL_ENTITY scopes: the actor needs
      // authority over the destination employer too.
      if (input.legalEntityId) await enforceInTx(tx, actor, "employees.edit", { legalEntityId: input.legalEntityId });

      const updated = await tx.employee.update({ where: { id: employee.id }, data: input, select: employeeSelect(now) });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "employee.update",
        targetType: "Employee",
        targetId: employee.id,
        previousValue: previous,
        newValue: next,
      });
      return projectForViewer(tx, actor, updated, decision);
    }),
  );
}

/**
 * Ends employment (soft: the record, placements and history stay). Needs `employees.archive` over
 * the employee. In one transaction it: sets TERMINATED + the termination date, ends every open
 * placement and manager assignment, deactivates the linked login and revokes its sessions
 * (access also stops on its own, because authz ignores terminated employees).
 * The termination date cannot be in the future or before the hire date.
 */
export async function terminateEmployee(
  actor: Actor,
  ctx: RequestContext,
  employeeId: string,
  input: TerminateEmployeeInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "employees.archive", { employeeId });
    const now = new Date();
    const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: employeeSelect(now) });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "The employee is already terminated." });
    if (input.terminationDate.getTime() > now.getTime()) {
      throw new ValidationError({ message: "The termination date cannot be in the future.", field: "terminationDate" });
    }
    if (employee.hireDate && input.terminationDate < employee.hireDate) {
      throw new ValidationError({ message: "The termination date is before the hire date.", field: "terminationDate" });
    }

    // Terminating takes the person out of authz entirely; never let that lock out a privileged user
    // the actor could not administer (HR must not be able to terminate the Owner).
    let mayDeactivateLogin = false;
    if (employee.userId) {
      await assertMayDisableUser(tx, actor, employee.userId);
      mayDeactivateLogin = (await canInTx(tx, actor, "users.archive", { employeeId: employee.id })).allowed;
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`employee-assignment:${employee.id}`}))`;
    const openPlacements = await tx.organizationalAssignment.findMany({
      where: { tenantId: actor.tenantId, employeeId: employee.id, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      select: { id: true, effectiveFrom: true },
    });
    for (const placement of openPlacements) {
      await tx.organizationalAssignment.update({ where: { id: placement.id }, data: { effectiveTo: endInstant(placement.effectiveFrom, now) } });
    }
    const openManagers = await tx.orgUnitManager.findMany({
      where: { tenantId: actor.tenantId, employeeId: employee.id, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      select: { id: true, effectiveFrom: true },
    });
    for (const manager of openManagers) {
      await tx.orgUnitManager.update({ where: { id: manager.id }, data: { effectiveTo: endInstant(manager.effectiveFrom, now) } });
    }

    let revokedSessions = 0;
    // Deactivating the LOGIN is user administration: it needs users.archive over that user. Without
    // it the employee record is still terminated (and authz ignores them), but the account is left
    // for a user administrator and the audit event says so.
    if (employee.userId && mayDeactivateLogin) {
      await tx.user.update({ where: { id: employee.userId }, data: { status: "DEACTIVATED" } });
      revokedSessions = await revokeAllSessionsForUser(tx, actor.tenantId, employee.userId);
    }

    const terminated = await tx.employee.update({
      where: { id: employee.id },
      data: { status: "TERMINATED", terminationDate: input.terminationDate },
      select: employeeSelect(now),
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "employee.terminate",
      targetType: "Employee",
      targetId: employee.id,
      previousValue: { status: employee.status, terminationDate: null },
      newValue: {
        status: "TERMINATED",
        terminationDate: input.terminationDate.toISOString().slice(0, 10),
        endedPlacements: openPlacements.length,
        endedManagerAssignments: openManagers.length,
        deactivatedUserId: mayDeactivateLogin ? employee.userId : null,
        loginLeftActiveForUserAdministrator: Boolean(employee.userId) && !mayDeactivateLogin,
        revokedSessions,
      },
      reason: input.reason,
    });
    return projectFields(withDerivedFields(terminated), decision, EMPLOYEE_API_FIELD_MAP);
  });
}

/** One employee (`employees.view` over them); outside the caller's scope it is a 404. Fields follow the grant. */
export async function getEmployee(actor: Actor, employeeId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "employees.view", { employeeId });
    const now = new Date();
    const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: employeeSelect(now) });
    if (!employee) throw new NotFoundError();
    return projectFields(withDerivedFields(employee), decision, EMPLOYEE_API_FIELD_MAP);
  });
}

/**
 * One page of employees the caller may see, ordered by last then first name. The data scope is
 * part of the query (`withinScope`), and each row is projected with the field sets of the scope part
 * that matched THAT row (`projectRows`), so a financial grant on City A never leaks into City B rows.
 */
export async function listEmployees(actor: Actor, query: ListEmployeesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "employees.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "employees.view", now);

    const callerWhere: Prisma.EmployeeWhereInput = {
      tenantId: actor.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.legalEntityId ? { legalEntityId: query.legalEntityId } : {}),
      ...(query.orgUnitId ? { assignments: { some: { orgUnitId: query.orgUnitId, ...effectiveAt(now) } } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: "insensitive" } },
              { lastName: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
              { employeeNumber: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await tx.employee.findMany({
      where: withinScope(buildScopeWhere(scope, employeeScopeColumns, now), callerWhere),
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: employeeSelect(now),
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = projectRows(page.data.map(withDerivedFields), scope, EMPLOYEE_API_FIELD_MAP, employeeRowAttributes);
    return { data, page: page.page };
  });
}
