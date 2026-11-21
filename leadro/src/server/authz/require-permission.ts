import { ForbiddenError, NotFoundError, type Actor } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { logger } from "@/server/logging";
import { canInTx } from "./can";
import { isPermissionKey } from "./permission-catalog";
import type { AccessDecision, ResourceRef } from "./types";

/** Builds the record reference from validated input. It must load attributes from the DB. */
export type ResourceResolver<TInput> = (actor: Actor, input: TInput) => ResourceRef | Promise<ResourceRef>;

/** Reasons for which the caller learns nothing about the record: reported as "not found". */
const HIDDEN_RECORD_REASONS = new Set(["OUT_OF_SCOPE", "RESOURCE_NOT_FOUND"]);

/** Best effort: a failing audit write must never turn a denial into a success or a 500. */
async function auditDenial(actor: Actor, permission: string, decision: AccessDecision): Promise<void> {
  try {
    await withTenant(actor.tenantId, (tx) =>
      recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "authz.denied",
        targetType: "Permission",
        targetId: permission,
        newValue: { reason: decision.reason },
        outcome: "DENIED",
        sourceApp: "API",
      }),
    );
  } catch (error) {
    logger.error("failed to record authorization denial", { permission, error: String(error) });
  }
}

/**
 * Returns a function for `defineRoute({ authorize })` that enforces `permission`.
 *
 *   authorize: requirePermission("employees.view", (_actor, { params }) => ({ employeeId: params.id }))
 *
 * Without a resolver it is a capability check (use `scopeFilter` to narrow list results). With one,
 * the record must fall inside a data scope of the granting assignment.
 *
 * Errors (§20.4): no grant -> `ForbiddenError`; a record that is out of scope, missing, or in
 * another tenant -> `NotFoundError`, so existence is never confirmed to someone who may not see it
 * (PERMISSIONS.md 4.6). Every denial is written to the audit log with outcome DENIED.
 *
 * @throws Error at route-definition time when `permission` is not in the catalog (a typo must not
 *   silently deny, or worse, be forgotten).
 */
export function requirePermission<TInput = unknown>(
  permission: string,
  resolveResource?: ResourceResolver<TInput>,
): (actor: Actor, input: TInput) => Promise<void> {
  if (!isPermissionKey(permission)) throw new Error(`requirePermission: unknown permission "${permission}"`);

  return async (actor, input) => {
    const resource = resolveResource ? await resolveResource(actor, input) : undefined;
    const decision = await withTenant(actor.tenantId, (tx) => canInTx(tx, actor, permission, resource));
    if (decision.allowed) return;

    await auditDenial(actor, permission, decision);
    if (HIDDEN_RECORD_REASONS.has(decision.reason)) throw new NotFoundError();
    throw new ForbiddenError();
  };
}
