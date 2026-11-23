import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { NotFoundError, conflictOnUniqueViolation, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateLeadSourceInput, UpdateLeadSourceInput } from "./schemas";

/**
 * Lead sources (§6.2): the channels leads arrive through. Sources are tenant configuration: anyone who may view
 * leads can list them (the intake form needs the choices); changing them needs `leads.manage` with a TENANT scope
 * (a source is not part of one org unit). Sources are deactivated, never deleted (leads keep pointing at them).
 */

const sourceSelect = { id: true, code: true, name: true, type: true, active: true, createdAt: true, updatedAt: true } satisfies Prisma.LeadSourceSelect;

export async function listLeadSources(actor: Actor): Promise<Array<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    return tx.leadSource.findMany({ where: { tenantId: actor.tenantId }, select: sourceSelect, orderBy: [{ name: "asc" }, { id: "asc" }] });
  });
}

export async function createLeadSource(actor: Actor, ctx: RequestContext, input: CreateLeadSourceInput): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation("A lead source with this code already exists.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "leads.manage", {}); // {} = tenant-level record: needs a TENANT scope (403 otherwise)
      const source = await tx.leadSource.create({ data: { tenantId: actor.tenantId, ...input }, select: sourceSelect });
      await recordAudit(tx, { ...auditContextFields(ctx), action: "lead_source.create", targetType: "LeadSource", targetId: source.id, newValue: input });
      return source;
    }),
  );
}

export async function updateLeadSource(
  actor: Actor,
  ctx: RequestContext,
  sourceId: string,
  input: UpdateLeadSourceInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.manage", {});
    const current = await tx.leadSource.findFirst({ where: { id: sourceId, tenantId: actor.tenantId }, select: sourceSelect });
    if (!current) throw new NotFoundError();
    const source = await tx.leadSource.update({ where: { id: sourceId }, data: input, select: sourceSelect });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead_source.update",
      targetType: "LeadSource",
      targetId: sourceId,
      previousValue: { name: current.name, active: current.active },
      newValue: input,
    });
    return source;
  });
}
