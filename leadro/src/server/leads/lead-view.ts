import { canInTx, projectFields } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { LEAD_API_FIELD_MAP, leadRowSelect, leadView, type LeadRow } from "./fields";
import { leadRowAttributes, toLeadResourceRef } from "./lead-access";

/** Reads one lead row with everything the view and the scope check need (inside the caller's tenant). */
export async function loadLeadRow(tx: TenantTx, tenantId: string, leadId: string): Promise<LeadRow | null> {
  return tx.lead.findFirst({ where: { id: leadId, tenantId }, select: leadRowSelect });
}

/**
 * What a write may show its caller: the lead as the `leads.view` decision allows AFTER the change. Falls back to
 * `{ id }` when the caller may no longer see the lead (e.g. a reassignment took their ASSIGNED access away, or the
 * lead moved out of their unit), so a write response never reveals more than a read would.
 */
export async function leadViewAfterWrite(tx: TenantTx, actor: Actor, leadId: string): Promise<Record<string, unknown>> {
  const row = await loadLeadRow(tx, actor.tenantId, leadId);
  if (!row) throw new NotFoundError();
  const attributes = (await leadRowAttributes(tx, actor.tenantId, [row])).get(row.id);
  if (!attributes) throw new NotFoundError();
  const decision = await canInTx(tx, actor, "leads.view", toLeadResourceRef(row, attributes));
  if (!decision.allowed) return { id: row.id };
  return projectFields(leadView(row, attributes.assignedEmployeeIds[0] ?? null), decision, LEAD_API_FIELD_MAP);
}
