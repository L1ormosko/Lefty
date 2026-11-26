import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { localIsoDate } from "@/lib/zoned-time";
import { canInTx, employeeScopeColumns, enforceInTx, type ScopeColumns } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Shared rules of the development module. Plans and recommendations are ABOUT an employee, so their data scope is the
 * employee's (org placements, legal employer, OWN), like training and coaching records. Out of scope is a 404.
 */

export type DevelopmentPlanPermission = "development_plans.view" | "development_plans.create" | "development_plans.edit";

/** Scope columns of a model that has an `employee` relation: the employee's own scope rules apply. */
export function viaEmployee<W extends object>(wrap: (employee: Prisma.EmployeeWhereInput) => W): ScopeColumns<W> {
  const { orgUnit, legalEntity, own } = employeeScopeColumns;
  return {
    orgUnit: orgUnit && ((ids, now) => wrap(orgUnit(ids, now))),
    legalEntity: legalEntity && ((ids, now) => wrap(legalEntity(ids, now))),
    own: own && ((employeeId, now) => wrap(own(employeeId, now))),
  };
}

export const planScopeColumns = viaEmployee<Prisma.DevelopmentPlanWhereInput>((employee) => ({ employee }));
export const recommendationScopeColumns = viaEmployee<Prisma.TrainingRecommendationWhereInput>((employee) => ({ employee }));

/**
 * `permission` over the employee. The capability is checked first (a 403 must not depend on the id), then the scope:
 * a record outside the scope is a 404, so its existence is never confirmed.
 */
export async function enforceOverEmployee(tx: TenantTx, actor: Actor, permission: string, employeeId: string): Promise<void> {
  await enforceInTx(tx, actor, permission, { employeeId });
}

/**
 * Development records about the CALLER are not read or changed through a management grant (review P5-R1/R2): a manager
 * placed in their own unit (or HR, tenant-wide) would otherwise read the review notes about them, which self-service hides,
 * and rewrite, cancel or decide what their own manager set up for them. They read their plans through `/api/v1/me/*`.
 */
export const isAboutCaller = (actor: Actor, employeeId: string): boolean => actor.employeeId !== null && actor.employeeId === employeeId;

/** List fragment that leaves out records about the caller (see `isAboutCaller`). */
export const notAboutCaller = (actor: Actor): { employeeId?: { not: string } } => (actor.employeeId ? { employeeId: { not: actor.employeeId } } : {});

/** Nobody runs a development plan about themselves (it is the management chain's or HR's plan for the person). */
export function assertNotAboutSelf(actor: Actor, employeeId: string): void {
  if (actor.employeeId === employeeId) throw new ForbiddenError({ message: "You cannot run a development plan about yourself." });
}

/**
 * Free text (titles, summaries, review bodies) is never audited (spec 22.2: `audit.view` holders do not necessarily see
 * development plans). A text change is recorded as this SHA-256 digest: it proves that and when the text changed.
 */
export const textDigest = (text: string | null): string | null => (text === null ? null : createHash("sha256").update(text, "utf8").digest("hex"));

/** A `YYYY-MM-DD` string as the value of a Postgres `date` column. */
export const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
export const isoDateOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** The tenant's calendar: its default time zone and today's date there. */
export async function tenantCalendar(tx: TenantTx, tenantId: string, now: Date = new Date()): Promise<{ timeZone: string; today: string }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  return { timeZone: tenant.defaultTimeZone, today: localIsoDate(now.getTime(), tenant.defaultTimeZone) };
}

/**
 * The plan owner must be an active user of the tenant who could run the plan (`development_plans.edit` over the
 * employee) and is not the employee themself. Refused as a 400 on `ownerId` (the caller picked them).
 */
export async function assertEligibleOwner(tx: TenantTx, tenantId: string, ownerId: string, employeeId: string): Promise<void> {
  const refuse = () => new ValidationError({ message: "This person cannot own this development plan.", field: "ownerId" });
  const owner = await tx.user.findFirst({ where: { id: ownerId, tenantId, status: "ACTIVE" }, select: { employee: { select: { id: true } } } });
  if (!owner || owner.employee?.id === employeeId) throw refuse();
  const decision = await canInTx(tx, { tenantId, userId: ownerId }, "development_plans.edit", { employeeId });
  if (!decision.allowed) throw refuse();
}

/** Row lock so concurrent changes of one record serialize (the second sees the new state). 404 when missing. */
export async function lockRow(tx: TenantTx, table: "DevelopmentPlan" | "TrainingRecommendation", tenantId: string, id: string): Promise<void> {
  const rows =
    table === "DevelopmentPlan"
      ? await tx.$queryRaw<unknown[]>`SELECT id FROM "DevelopmentPlan" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`
      : await tx.$queryRaw<unknown[]>`SELECT id FROM "TrainingRecommendation" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError();
}
