import { activePlacementWhere, enforceInTx } from "@/server/authz";
import { ForbiddenError, NotFoundError, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";

/** The operational placement an employee had at one instant. */
export interface OrgUnitAtResult {
  assignmentId: string;
  orgUnitId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Historical reporting primitive (§3.4): the org unit an employee was PRIMARILY placed in at `at`,
 * or null if they had no placement then (before hire, in a gap, after termination). Reports must
 * use this, not the employee's current unit, so a transfer never rewrites past numbers.
 *
 * It answers from the placement history only: it does not check who is asking. Permission-checked
 * callers (the API route) do that first. Runs in the caller's tenant transaction.
 */
export async function orgUnitAtInTx(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  at: Date,
): Promise<OrgUnitAtResult | null> {
  const row = await tx.organizationalAssignment.findFirst({
    where: { tenantId, employeeId, kind: "PRIMARY", ...activePlacementWhere(at) },
    orderBy: { effectiveFrom: "desc" },
    select: { id: true, orgUnitId: true, effectiveFrom: true, effectiveTo: true },
  });
  return row ? { assignmentId: row.id, orgUnitId: row.orgUnitId, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo } : null;
}

/** `orgUnitAtInTx` in its own tenant transaction. */
export function orgUnitAt(tenantId: string, employeeId: string, at: Date): Promise<OrgUnitAtResult | null> {
  return withTenant(tenantId, (tx) => orgUnitAtInTx(tx, tenantId, employeeId, at));
}

/**
 * `orgUnitAt` for an API caller: needs `employees.view` over the employee (404 outside the
 * caller's scope) with the `base` field set, because the answer reveals where they worked.
 */
export function getOrgUnitAtAsActor(actor: Actor, employeeId: string, at: Date): Promise<OrgUnitAtResult | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "employees.view", { employeeId });
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();
    const exists = await tx.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundError();
    return orgUnitAtInTx(tx, actor.tenantId, employeeId, at);
  });
}
