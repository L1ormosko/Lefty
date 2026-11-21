import { ForbiddenError, NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { canInTx } from "./can";
import type { AccessDecision, AccessSubject, ResourceRef } from "./types";

/**
 * The in-transaction permission gate for service functions (the route-level gate is
 * `requirePermission`). Services re-check inside their own write transaction so that a permission
 * or scope change between the route's check and the write cannot be exploited, and so a service
 * is safe to call from anywhere (server actions, jobs), not only from a route.
 *
 *  - no `resource`: capability check, 403 when no active grant carries the permission;
 *  - `resource` describing a record (org unit, employee, ...): capability first (403), then the
 *    record against the scopes of the granting assignment. Every denial after that is 404, so the
 *    existence of records outside the caller's scope is never confirmed;
 *  - `resource` = `{}` (a tenant-level record such as company settings): needs a TENANT scope; a
 *    denial is a 403 because there is no individual record to hide.
 *
 * Unlike `requirePermission` it does not audit the denial: the surrounding transaction rolls back
 * when this throws, which would roll the audit row back too. Routes get audited denials from their
 * `authorize` hook.
 *
 * @returns the decision, whose `fieldSets` the caller must use to project what it returns.
 * @throws ForbiddenError | NotFoundError
 */
export async function enforceInTx(
  tx: TenantTx,
  actor: AccessSubject,
  permission: string,
  resource?: ResourceRef,
  now: Date = new Date(),
): Promise<AccessDecision> {
  const capability = await canInTx(tx, actor, permission, undefined, now);
  if (!capability.allowed) throw new ForbiddenError();
  if (resource === undefined) return capability;

  const decision = await canInTx(tx, actor, permission, resource, now);
  if (decision.allowed) return decision;
  const isTenantLevel = Object.keys(resource).length === 0;
  throw isTenantLevel ? new ForbiddenError() : new NotFoundError();
}

/**
 * `enforceInTx` for an action on another USER account. The target's place in the org tree is that of
 * their employee record; a user with no employee (the company Owner, say) is tenant-level and only a
 * TENANT scope reaches them. Either way a user outside the caller's scope is a 404, never a 403:
 * a 403 here would confirm that a tenant-level account exists.
 *
 * @throws ForbiddenError when the caller holds no grant of `permission` at all, NotFoundError otherwise.
 */
export async function enforceOnUser(
  tx: TenantTx,
  actor: AccessSubject,
  permission: string,
  target: { employeeId: string | null },
  now: Date = new Date(),
): Promise<AccessDecision> {
  await enforceInTx(tx, actor, permission, undefined, now); // capability: 403
  const decision = await canInTx(tx, actor, permission, target.employeeId ? { employeeId: target.employeeId } : {}, now);
  if (!decision.allowed) throw new NotFoundError();
  return decision;
}
