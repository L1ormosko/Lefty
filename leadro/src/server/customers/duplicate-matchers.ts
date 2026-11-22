import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { conflictOnUniqueViolation, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { loadDuplicateMatchers, type DuplicateMatchers } from "./duplicate-detection";
import type { DuplicateMatchersInput } from "./schemas";

/** The tenant's duplicate-matcher configuration (§6.4 "configurable matching"). */
export interface DuplicateMatcherSettings {
  matchers: DuplicateMatchers;
  /** True while the tenant has never saved a configuration (the defaults apply). */
  isDefault: boolean;
}

/** The effective matchers. Any `customers.view` holder may read them (they explain why a flag exists). */
export async function getDuplicateMatchers(actor: Actor): Promise<DuplicateMatcherSettings> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const stored = await tx.operationsSettings.findFirst({ where: { tenantId: actor.tenantId }, select: { duplicateMatchers: true } });
    return { matchers: await loadDuplicateMatchers(tx, actor.tenantId), isDefault: !stored?.duplicateMatchers };
  });
}

/**
 * Replaces the matcher configuration. Needs `customers.manage` with a TENANT scope (it changes how
 * every customer is matched). Only affects future detection; existing flags and decisions stay.
 */
export async function setDuplicateMatchers(
  actor: Actor,
  ctx: RequestContext,
  input: DuplicateMatchersInput,
): Promise<DuplicateMatcherSettings> {
  return conflictOnUniqueViolation("The settings were changed at the same time. Try again.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "customers.manage", {});
      const previous = await loadDuplicateMatchers(tx, actor.tenantId);
      // OperationsSettings is one row per tenant, created lazily (absent = defaults).
      await tx.operationsSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, duplicateMatchers: input, updatedById: actor.userId },
        update: { duplicateMatchers: input, updatedById: actor.userId },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "customer.duplicate_matchers_update",
        targetType: "OperationsSettings",
        previousValue: previous,
        newValue: input,
      });
      return { matchers: input, isDefault: false };
    }),
  );
}
