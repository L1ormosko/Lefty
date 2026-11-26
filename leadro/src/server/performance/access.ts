import type { Prisma } from "@prisma/client";
import { activePlacementWhere, canInTx, enforceInTx, type ScopeColumns } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Who may do what with performance data (PERMISSIONS.md "Phase 5", DECISIONS.md "Phase 5 Task 1" rulings 2 and 5).
 *
 * - Definitions are tenant-level configuration: authoring (create, version, edit, submit, withdraw, retire) needs
 *   `performance.configure` at TENANT scope. Publishing is the approval engine's decision (`performance.publish`, never the author).
 * - Reading definitions is the `performance.view` capability; a caller without `performance.configure` sees only versions that
 *   were published (spec 10.2: a definition is visible to employees only once published).
 * - Values are read with `performance.view` over the EMPLOYEE (their current placements / employer, or OWN). Values of a version
 *   that was never published are previews: only `performance.configure` or `performance.manage` holders see them, and never
 *   their own (an employee sees their own values of published definitions only, whatever else they hold).
 * - Computing needs `performance.manage` over every employee computed (managers: their unit).
 */

export const hasCapability = async (tx: TenantTx, actor: Actor, permission: string): Promise<boolean> => (await canInTx(tx, actor, permission)).allowed;

/** The `performance.view` capability (any scope). @throws ForbiddenError */
export async function enforceViewCapability(tx: TenantTx, actor: Actor): Promise<void> {
  await enforceInTx(tx, actor, "performance.view");
}

/** `performance.configure` over the tenant as a whole (definitions have no org unit). @throws ForbiddenError */
export async function enforceConfigure(tx: TenantTx, actor: Actor): Promise<void> {
  await enforceInTx(tx, actor, "performance.configure", {});
}

/** Definitions the caller may see: everything for authors, otherwise only versions that were published (current or retired). */
export async function definitionVisibilityWhere(tx: TenantTx, actor: Actor): Promise<Prisma.PerformanceMetricDefinitionWhereInput> {
  if (await hasCapability(tx, actor, "performance.configure")) return {};
  return { publishedAt: { not: null } };
}

/**
 * Values the caller may see regardless of scope: values of published versions, plus (for authors and managers) previews of
 * unpublished versions about OTHER employees. Combine with the scope fragment through `withinScope`.
 */
export async function valueVisibilityWhere(tx: TenantTx, actor: Actor): Promise<Prisma.PerformanceMetricValueWhereInput> {
  const published: Prisma.PerformanceMetricValueWhereInput = { definition: { publishedAt: { not: null } } };
  const mayPreview = (await hasCapability(tx, actor, "performance.configure")) || (await hasCapability(tx, actor, "performance.manage"));
  if (!mayPreview) return published;
  // Own values stay published-only: "the employee sees values of PUBLISHED definitions only" holds for managers too.
  const notOwn: Prisma.PerformanceMetricValueWhereInput = actor.employeeId ? { employeeId: { not: actor.employeeId } } : {};
  return { OR: [published, notOwn] };
}

/**
 * Scope columns of a metric value: the value's EMPLOYEE decides (current active placements for ORG_UNIT, the legal employer
 * for LEGAL_ENTITY, the employee for OWN), exactly as `requirePermission(..., { employeeId })` resolves one employee.
 * ASSIGNED has no meaning for performance data.
 */
export const valueScopeColumns: ScopeColumns<Prisma.PerformanceMetricValueWhereInput> = {
  orgUnit: (orgUnitIds, now) => ({ employee: { assignments: { some: { orgUnitId: { in: orgUnitIds }, ...activePlacementWhere(now) } } } }),
  legalEntity: (legalEntityIds) => ({ employee: { legalEntityId: { in: legalEntityIds } } }),
  own: (employeeId) => ({ employeeId }),
};

/** Same scope over employee rows (who may be computed). */
export const employeeComputeScopeColumns: ScopeColumns<Prisma.EmployeeWhereInput> = {
  orgUnit: (orgUnitIds, now) => ({ assignments: { some: { orgUnitId: { in: orgUnitIds }, ...activePlacementWhere(now) } } }),
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
  own: (employeeId) => ({ id: employeeId }),
};

/**
 * Serializes every change to the versions of one key (create version, submit, publish, retire): the rows of the key are
 * locked `FOR UPDATE`, so "one open version per key" and "one PUBLISHED version per key" are checked without races.
 */
export async function lockDefinitionKey(tx: TenantTx, tenantId: string, key: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PerformanceMetricDefinition" WHERE "tenantId" = ${tenantId} AND "key" = ${key} FOR UPDATE`;
}
