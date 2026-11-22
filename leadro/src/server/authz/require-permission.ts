import { ForbiddenError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { canInTx } from "./can";
import { recordAuthzDenial } from "./denial-audit";
import { isPermissionKey } from "./permission-catalog";
import type { AccessDecision, ResourceRef } from "./types";

/**
 * Builds the record reference from validated input, inside the SAME transaction as the permission
 * check (`tx`). It must load attributes from the database, never from the request body. Return
 * `null` when the record does not exist: the caller then gets 404, exactly like an out-of-scope one.
 */
export type ResourceResolver<TInput> = (
  actor: Actor,
  input: TInput,
  tx: TenantTx,
) => ResourceRef | null | Promise<ResourceRef | null>;

/**
 * Returns a function for `defineRoute({ authorize })` that enforces `permission`.
 *
 *   authorize: requirePermission("employees.view", (_actor, { params }) => ({ employeeId: params.id }))
 *
 * Order: (1) capability check, so a caller with no grant gets 403 without the record being touched;
 * (2) the resolver, then (3) the check against the record. Once a record is involved EVERY denial
 * (out of scope, condition not met, no scope, missing, cross-tenant) is a 404, so existence is never
 * confirmed to someone who may not see it. All steps share one transaction; every denial is audited
 * (with the request's correlation id when `defineRoute` passes its context).
 *
 * Without a resolver it is a capability check only (use `scopeFilter` to narrow list results).
 * Routes returning a record must still project it with the decision's field sets (`can` +
 * `projectFields`): a field-limited grant passes this gate.
 *
 * @throws Error at route-definition time when `permission` is not in the catalog.
 */
export function requirePermission<TInput = unknown>(
  permission: string,
  resolveResource?: ResourceResolver<TInput>,
): (actor: Actor, input: TInput, ctx?: RequestContext) => Promise<void> {
  if (!isPermissionKey(permission)) throw new Error(`requirePermission: unknown permission "${permission}"`);

  return async (actor, input, ctx) => {
    const { decision, recordInvolved } = await withTenant(actor.tenantId, async (tx) => {
      const capability = await canInTx(tx, actor, permission);
      if (!capability.allowed || !resolveResource) return { decision: capability, recordInvolved: false };

      const resource = await resolveResource(actor, input, tx);
      if (resource === null) {
        const missing: AccessDecision = { allowed: false, reason: "RESOURCE_NOT_FOUND", via: null, fieldSets: [] };
        return { decision: missing, recordInvolved: true };
      }
      return { decision: await canInTx(tx, actor, permission, resource), recordInvolved: true };
    });
    if (decision.allowed) return;

    await recordAuthzDenial(actor, permission, ctx, decision.reason);
    if (recordInvolved) throw new NotFoundError();
    throw new ForbiddenError();
  };
}

/**
 * Like `requirePermission` for records that belong to the tenant as a whole and have no org
 * placement (company settings, roles, translations, legal entities): the caller needs the
 * permission with a TENANT scope, and a denial is a plain 403 (there is no individual record whose
 * existence needs hiding). Denials are audited like `requirePermission`'s.
 */
export function requireTenantLevelPermission(
  permission: string,
): (actor: Actor, input: unknown, ctx?: RequestContext) => Promise<void> {
  if (!isPermissionKey(permission)) throw new Error(`requireTenantLevelPermission: unknown permission "${permission}"`);

  return async (actor, _input, ctx) => {
    const decision = await withTenant(actor.tenantId, (tx) => canInTx(tx, actor, permission, {}));
    if (decision.allowed) return;
    await recordAuthzDenial(actor, permission, ctx, decision.reason);
    throw new ForbiddenError();
  };
}
