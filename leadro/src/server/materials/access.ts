import { canInTx, enforceInTx } from "@/server/authz";
import { ForbiddenError, NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { COST_FIELD_SET, materialRowSelect, type MaterialRow } from "./fields";

/**
 * Who may do what with materials (PERMISSIONS.md section 11).
 *
 * The catalog is tenant-wide reference data (materials have no org unit): reading it is a CAPABILITY (`materials.view`
 * with any scope, so a technician can pick a material), and changing it needs the permission at TENANT scope
 * (`requireTenantLevelPermission` in the routes, `enforceInTx(..., {})` here).
 * Costs are the opt-in `cost` field set: they are shown, written (proposing a cost) and computed (costing a job's materials)
 * only for a caller whose `materials.view` grant names the set. A plain `materials.view` never reveals a cost.
 */

/** The `materials.view` decision of the caller (403 without it); its `fieldSets` say whether costs are visible. */
export async function enforceMaterialsView(tx: TenantTx, actor: Actor) {
  return enforceInTx(tx, actor, "materials.view");
}

/** Does the caller hold the `cost` set of `materials.view` (any scope: the catalog is tenant-wide)? */
export async function holdsCostFieldSet(tx: TenantTx, actor: Actor): Promise<boolean> {
  const decision = await canInTx(tx, actor, "materials.view");
  return decision.allowed && decision.fieldSets.includes(COST_FIELD_SET);
}

/**
 * Refuses a caller without the `cost` set (403). Costs are a capability, not a record: there is no existence to hide.
 * @throws ForbiddenError
 */
export async function enforceCostFieldSet(tx: TenantTx, actor: Actor): Promise<void> {
  if (!(await holdsCostFieldSet(tx, actor))) throw new ForbiddenError({ message: "Material costs are not visible to you." });
}

/** A catalog change needs `permission` over the tenant as a whole (materials are tenant-level records). */
export async function enforceCatalogPermission(tx: TenantTx, actor: Actor, permission: "materials.create" | "materials.edit" | "materials.archive"): Promise<void> {
  await enforceInTx(tx, actor, permission, {});
}

/**
 * Locks the material row (`SELECT ... FOR UPDATE`) and returns it, 404 when missing. Every cost-version change, approval
 * and costing of a usage of this material takes this lock first, so a new version cannot be approved while a usage is
 * being costed with the old one (the placement rule in `material-cost-rules.ts` relies on it).
 * @throws NotFoundError
 */
export async function lockMaterial(tx: TenantTx, tenantId: string, materialId: string): Promise<MaterialRow> {
  await tx.$queryRaw`SELECT id FROM "Material" WHERE id = ${materialId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const row = await tx.material.findFirst({ where: { id: materialId, tenantId }, select: materialRowSelect });
  if (!row) throw new NotFoundError();
  return row;
}
