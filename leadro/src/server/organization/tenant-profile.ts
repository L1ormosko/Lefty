import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { baseFieldMap, enforceInTx, projectFields } from "@/server/authz";
import { NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import type { UpdateTenantProfileInput } from "./schemas";

/**
 * The company profile (§3.1): name and the locale / time-zone defaults every user, branch and
 * report falls back to. The `slug` (company code used to log in) is deliberately immutable here.
 * The tenant is always the caller's own, taken from the session, never from the request.
 */

const TENANT_PROFILE_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  defaultLocale: true,
  defaultTimeZone: true,
  createdAt: true,
  updatedAt: true,
} as const;

const TENANT_PROFILE_FIELD_MAP = baseFieldMap(Object.keys(TENANT_PROFILE_SELECT));

/** The caller's company profile. Needs `company_settings.view` (tenant-level record). */
export async function getTenantProfile(actor: Actor): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "company_settings.view", {});
    // `Tenant` has no row-level security (it is resolved by slug at login), so the id filter is
    // the isolation here: it is always the actor's own tenant.
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId }, select: TENANT_PROFILE_SELECT });
    if (!tenant) throw new NotFoundError();
    return projectFields(tenant, decision, TENANT_PROFILE_FIELD_MAP);
  });
}

/** Edits the company profile. Needs `company_settings.edit`; audited with the changed fields. */
export async function updateTenantProfile(
  actor: Actor,
  ctx: RequestContext,
  input: UpdateTenantProfileInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "company_settings.edit", {});
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId }, select: TENANT_PROFILE_SELECT });
    if (!tenant) throw new NotFoundError();

    const { changedKeys, previous, next } = changedFields(tenant, input);
    if (changedKeys.length === 0) return projectFields(tenant, decision, TENANT_PROFILE_FIELD_MAP);
    const updated = await tx.tenant.update({ where: { id: actor.tenantId }, data: input, select: TENANT_PROFILE_SELECT });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "tenant.update",
      targetType: "Tenant",
      targetId: actor.tenantId,
      previousValue: previous,
      newValue: next,
    });
    return projectFields(updated, decision, TENANT_PROFILE_FIELD_MAP);
  });
}
