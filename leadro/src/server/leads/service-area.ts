import { enforceInTx, type AccessDecision, type ResourceRef } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * A lead is filed under a service-area org unit. Putting a lead in a unit needs the permission over THAT unit (a
 * City A manager cannot file a lead under City B), and the unit must be active. The unit row is locked `FOR SHARE`
 * so a concurrent archive of the unit cannot slip in between this check and the write.
 *
 * @param baseRef the lead's other attributes (assigned employees, record sets), so ASSIGNED and set-qualified grants are judged
 *   against the real lead; only its org unit is replaced by `orgUnitId`
 * @throws NotFoundError when the unit is missing or outside the caller's scope (existence not leaked)
 * @throws InvalidStateTransitionError when the unit is archived
 */
export async function assertLeadServiceAreaUsable(
  tx: TenantTx,
  actor: Actor,
  permission: string,
  orgUnitId: string,
  baseRef: ResourceRef,
): Promise<AccessDecision> {
  const decision = await enforceInTx(tx, actor, permission, { ...baseRef, orgUnitId });
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM "OrgUnit" WHERE id = ${orgUnitId} AND "tenantId" = ${actor.tenantId} FOR SHARE`;
  const unit = rows[0];
  if (!unit) throw new NotFoundError();
  if (!unit.active) throw new InvalidStateTransitionError({ message: "Leads cannot be filed under an archived unit." });
  return decision;
}
