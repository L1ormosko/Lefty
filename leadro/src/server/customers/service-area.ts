import { enforceInTx, type AccessDecision, type ResourceRef } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * A customer or address is filed under a service-area org unit (branch/city). Putting a record in a
 * unit needs the permission over THAT unit (a City A manager cannot file a customer under City B), and
 * the unit must be active. The row is locked `FOR SHARE` so a concurrent archive of the unit cannot
 * slip in between this check and the insert.
 *
 * @param permission the write permission being exercised (`customers.create` or `customers.edit`)
 * @param baseRef the record's other attributes (assigned employees, record sets) so set-qualified and ASSIGNED grants
 *   are judged against the real record; only its org unit is replaced by `orgUnitId`
 * @returns the decision, whose field sets the caller uses for write checks
 * @throws NotFoundError when the unit is outside the caller's scope or missing (existence not leaked)
 * @throws InvalidStateTransitionError when the unit is archived
 */
export async function assertServiceAreaUsable(
  tx: TenantTx,
  actor: Actor,
  permission: string,
  orgUnitId: string,
  baseRef: ResourceRef = {},
): Promise<AccessDecision> {
  const decision = await enforceInTx(tx, actor, permission, { ...baseRef, orgUnitId });
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM "OrgUnit" WHERE id = ${orgUnitId} AND "tenantId" = ${actor.tenantId} FOR SHARE`;
  const unit = rows[0];
  if (!unit) throw new NotFoundError();
  if (!unit.active) {
    throw new InvalidStateTransitionError({ message: "Customers and addresses cannot be filed under an archived unit." });
  }
  return decision;
}
