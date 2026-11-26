import { localIsoDate } from "@/lib/zoned-time";
import { enforceInTx, type AccessDecision } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { assertBaseFields } from "./views";

/**
 * Who may do what with training (docs/PERMISSIONS.md section 12):
 *
 * - the course catalog is tenant-wide reference data: reading it is the `training.view` CAPABILITY (any scope), changing
 *   it needs `training.manage` at TENANT scope;
 * - assignments and records are scoped by the EMPLOYEE's data scope: `training.assign` to assign, `training.edit` to
 *   change / start / cancel an assignment, `training.create` to record a completion, `training.approve` to verify, reject
 *   or revoke one (HR), `training.view` to read. Out of scope is a 404 (existence is never confirmed).
 */

export type TrainingPermission =
  | "training.view"
  | "training.create"
  | "training.edit"
  | "training.assign"
  | "training.approve"
  | "training.manage";

/**
 * `permission` over the employee's records; also requires the `base` field set.
 * @throws ForbiddenError (no capability) | NotFoundError (employee out of scope)
 */
export async function enforceOverEmployee(tx: TenantTx, actor: Actor, permission: TrainingPermission, employeeId: string): Promise<AccessDecision> {
  const decision = await enforceInTx(tx, actor, permission, { employeeId });
  assertBaseFields(decision);
  return decision;
}

/** A catalog change needs `training.manage` over the tenant as a whole (courses have no org unit). */
export async function enforceCatalogManage(tx: TenantTx, actor: Actor): Promise<void> {
  await enforceInTx(tx, actor, "training.manage", {});
}

/** The tenant's calendar: its default time zone and today's date there (`YYYY-MM-DD`). */
export async function tenantCalendar(tx: TenantTx, tenantId: string, now: Date = new Date()): Promise<{ timeZone: string; today: string }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  return { timeZone: tenant.defaultTimeZone, today: localIsoDate(now.getTime(), tenant.defaultTimeZone) };
}

/**
 * The employee a new assignment or record is for. A terminated employee gets nothing new (their history stays readable).
 * @throws ValidationError (unknown employee) | InvalidStateTransitionError (terminated)
 */
export async function loadActiveEmployee(tx: TenantTx, tenantId: string, employeeId: string): Promise<{ id: string; userId: string | null }> {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, userId: true, status: true } });
  if (!employee) throw new ValidationError({ message: "Unknown employee.", field: "employeeId" });
  if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee gets no new training." });
  return { id: employee.id, userId: employee.userId };
}

/**
 * §21.3 separation of duties: nobody verifies, rejects or revokes their own training.
 * @throws ForbiddenError
 */
export async function assertNotOwnRecord(tx: TenantTx, actor: Actor, employeeId: string): Promise<void> {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: { userId: true } });
  if (employeeId === actor.employeeId || (employee?.userId && employee.userId === actor.userId)) {
    throw new ForbiddenError({ message: "You cannot decide on your own training records." });
  }
}

/**
 * Locks a row (`SELECT ... FOR UPDATE`) so two concurrent decisions on it serialize; the second one then sees the new
 * status and is refused by the status rules. 404 when missing.
 */
export async function lockRow(tx: TenantTx, table: "TrainingAssignment" | "TrainingRecord" | "TrainingCourse", tenantId: string, id: string): Promise<void> {
  const rows =
    table === "TrainingAssignment"
      ? await tx.$queryRaw<unknown[]>`SELECT id FROM "TrainingAssignment" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`
      : table === "TrainingRecord"
        ? await tx.$queryRaw<unknown[]>`SELECT id FROM "TrainingRecord" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`
        : await tx.$queryRaw<unknown[]>`SELECT id FROM "TrainingCourse" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError();
}
