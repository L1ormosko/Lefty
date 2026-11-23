import { ACTION_ONLY_STATUSES, isOwnedStatus } from "@/lib/lead-lifecycle";
import { enforceInTx, assertWritableFields, LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { leadResourceRef, visibleLeadIds } from "./lead-access";
import { leadViewAfterWrite } from "./lead-view";
import type { ChangeLeadStatusInput } from "./schemas";
import { applyLeadStatus, isLeadStatus } from "./status-change";

/**
 * Status changes requested by a person (§6.3). Needs `leads.edit` over the lead, and the grant must allow the
 * `status` (and, for LOST / CANCELLED / DUPLICATE, `closedReason` / `duplicateOfLeadId`) fields: a Technician's
 * `{fields:"status"}` grant allows `status` and `closedReason`, so an assigned Technician can move their lead
 * through contact and qualification but cannot mark it as a duplicate of another lead.
 *
 * Two statuses cannot be requested directly because they need more than a label: ASSIGNED needs an owner (use the
 * assign action) and CONVERTED needs a job (use the convert action). Releasing an owner is the unassign action, so
 * the §25.1 open-contact-attempt rule cannot be bypassed by a status change.
 */
export async function changeLeadStatus(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: ChangeLeadStatusInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.edit");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "leads.edit", ref);

    const changed = ["status", ...(input.reason ? ["closedReason"] : []), ...(input.duplicateOfLeadId ? ["duplicateOfLeadId"] : [])];
    assertWritableFields(decision, changed, LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);

    const lead = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { id: true, status: true, archivedAt: true } });
    if (!lead || !isLeadStatus(lead.status)) throw new NotFoundError();
    if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot change status. Restore it first." });

    if (ACTION_ONLY_STATUSES.includes(input.status)) {
      throw new ValidationError({
        message: input.status === "ASSIGNED" ? "Use the assign action to give a lead an owner." : "Use the convert action to turn a lead into a job.",
        field: "status",
      });
    }
    if (input.status === "UNASSIGNED" && isOwnedStatus(lead.status)) {
      throw new ValidationError({ message: "Use the unassign action to release a lead's owner.", field: "status" });
    }

    if (input.duplicateOfLeadId && !(await visibleLeadIds(tx, actor, [input.duplicateOfLeadId])).has(input.duplicateOfLeadId)) {
      // Same answer as for a lead that does not exist: the caller must not learn that an out-of-scope lead has this id.
      throw new ValidationError({ message: "The lead to duplicate was not found.", field: "duplicateOfLeadId" });
    }

    await applyLeadStatus(tx, actor, ctx, { id: lead.id, status: lead.status }, input.status, {
      reason: input.reason,
      duplicateOfLeadId: input.duplicateOfLeadId,
      assignmentEndedReason: `lead status ${input.status}`,
    });
    return leadViewAfterWrite(tx, actor, leadId);
  });
}

/** The status history of a lead, oldest first (§6.3: previous, new, who, when, reason). Needs `leads.view` over the lead. */
export async function listLeadStatusHistory(actor: Actor, leadId: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "leads.view", ref);
    return tx.leadStatusHistory.findMany({
      where: { tenantId: actor.tenantId, leadId },
      select: { id: true, fromStatus: true, toStatus: true, actorType: true, actorUserId: true, reason: true, occurredAt: true },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
  });
}
