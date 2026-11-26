import type { DataChallenge, Prisma } from "@prisma/client";
import { buildScopeWhere, employeeScopeColumns, enforceInTx, resolveScope, withinScope, type ScopeColumns } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { ListDataChallengesQuery } from "./schemas";
import { targetIdOf } from "./targets";

/**
 * Reading challenges (`data_challenges.view`, a sensitive permission: HR, the Owner, the managers who route them). The scope
 * is the challenged EMPLOYEE's. The employee reads their own challenges through self-service (`/api/v1/me/*`, Task 6).
 */

export const VIEW = "data_challenges.view";

/** A challenge in API responses: everything but the tenant, plus `targetId` (the id in the typed column of `targetType`). */
export type DataChallengeView = Omit<DataChallenge, "tenantId"> & { targetId: string };
export function toDataChallengeView(challenge: DataChallenge): DataChallengeView {
  const { tenantId: _tenantId, ...view } = challenge;
  return { ...view, targetId: targetIdOf(challenge) };
}

const challengeScopeColumns: ScopeColumns<Prisma.DataChallengeWhereInput> = {
  orgUnit: (orgUnitIds, now) => ({ employee: employeeScopeColumns.orgUnit?.(orgUnitIds, now) ?? { id: { in: [] } } }),
  legalEntity: (legalEntityIds, now) => ({ employee: employeeScopeColumns.legalEntity?.(legalEntityIds, now) ?? { id: { in: [] } } }),
  own: (employeeId) => ({ employeeId }),
};

/** Locks one challenge row (concurrent decisions serialize) and re-reads it. Null when it does not exist in the tenant. */
export async function lockChallenge(tx: TenantTx, tenantId: string, challengeId: string): Promise<DataChallenge | null> {
  await tx.$queryRaw`SELECT "id" FROM "DataChallenge" WHERE "id" = ${challengeId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return tx.dataChallenge.findFirst({ where: { id: challengeId, tenantId } });
}

/**
 * Loads (and row-locks) a challenge the actor may act on with `permission`: seeing it is the precondition (404 outside the
 * scope, no existence leak), then the action's own grant over the same employee.
 */
export async function loadForAction(tx: TenantTx, actor: Actor, challengeId: string, permission: string): Promise<DataChallenge> {
  await enforceInTx(tx, actor, permission);
  const challenge = await lockChallenge(tx, actor.tenantId, challengeId);
  if (!challenge) throw new NotFoundError();
  await enforceInTx(tx, actor, VIEW, { employeeId: challenge.employeeId });
  await enforceInTx(tx, actor, permission, { employeeId: challenge.employeeId });
  return challenge;
}

/** One challenge (404 outside the caller's scope). */
export async function getDataChallenge(actor: Actor, challengeId: string): Promise<DataChallengeView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const challenge = await tx.dataChallenge.findFirst({ where: { id: challengeId, tenantId: actor.tenantId } });
    if (!challenge) throw new NotFoundError();
    await enforceInTx(tx, actor, VIEW, { employeeId: challenge.employeeId });
    return toDataChallengeView(challenge);
  });
}

/** Challenges in the caller's scope, newest first; filter by status, employee, reviewer ("assigned to me") or target type. */
export async function listDataChallenges(actor: Actor, query: ListDataChallengesQuery): Promise<Page<DataChallengeView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const now = new Date();
    const scope = await resolveScope(tx, actor, VIEW, now);
    const callerWhere: Prisma.DataChallengeWhereInput = {
      tenantId: actor.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.reviewerId ? { reviewerId: query.reviewerId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };
    const rows = await tx.dataChallenge.findMany({
      where: withinScope(buildScopeWhere(scope, challengeScopeColumns, now), callerWhere),
      orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toDataChallengeView), page: page.page };
  });
}
