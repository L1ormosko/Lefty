import { LEAD_STATUSES, REASON_REQUIRED_STATUSES, canTransitionLead, isClosedStatus, type LeadStatusValue } from "@/lib/lead-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { ConflictError, InvalidStateTransitionError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * The ONE place a lead's status changes (§6.3). Every path that moves a lead (the status endpoint, assignment,
 * contact attempts, conversion, reopening) goes through `applyLeadStatus`, so every change is validated against
 * `src/lib/lead-lifecycle.ts`, writes a `LeadStatusHistory` row (previous, new, who, when, reason) and an audit
 * event in the caller's transaction.
 */

export interface LeadStatusSubject {
  id: string;
  status: LeadStatusValue;
}

export interface StatusChangeOptions {
  /** Required for LOST and CANCELLED. Also kept on the history row for any other change. */
  reason?: string | null;
  /** Required for DUPLICATE: the lead this one duplicates. */
  duplicateOfLeadId?: string | null;
  /** What ends the owner's assignment, when this change closes or releases the lead (shown on the assignment row). */
  assignmentEndedReason?: string;
}

/** The tenant's switched-off optional transitions (`OperationsSettings.disabledLeadTransitions`). */
export async function loadDisabledLeadTransitions(tx: TenantTx, tenantId: string): Promise<string[]> {
  const settings = await tx.operationsSettings.findFirst({ where: { tenantId }, select: { disabledLeadTransitions: true } });
  return settings?.disabledLeadTransitions ?? [];
}

/**
 * Moves `lead` to `to`. Throws `InvalidStateTransitionError` when the machine (after the tenant's narrowing)
 * does not allow it, `ValidationError` when a required reason or duplicate target is missing, and
 * `ConflictError` when someone else changed the status in the meantime (the update is guarded on the status we read).
 *
 * Side effects: the lead's ACTIVE assignment is ended whenever the lead is closed or released (so ASSIGNED scope
 * stops granting access to work that is over); `closedReason` / `duplicateOfLeadId` are set for the statuses that carry
 * them and cleared when the lead is reopened.
 */
export async function applyLeadStatus(
  tx: TenantTx,
  actor: Actor,
  ctx: RequestContext,
  lead: LeadStatusSubject,
  to: LeadStatusValue,
  options: StatusChangeOptions = {},
): Promise<void> {
  const disabled = await loadDisabledLeadTransitions(tx, actor.tenantId);
  if (!canTransitionLead(lead.status, to, disabled)) {
    throw new InvalidStateTransitionError({ message: `A lead cannot move from ${lead.status} to ${to}.`, field: "status" });
  }
  const reason = options.reason?.trim() || null;
  if (REASON_REQUIRED_STATUSES.includes(to) && !reason) {
    throw new ValidationError({ message: `A reason is required to move a lead to ${to}.`, field: "reason" });
  }
  if (to === "DUPLICATE") {
    if (!options.duplicateOfLeadId) throw new ValidationError({ message: "Name the lead this one duplicates.", field: "duplicateOfLeadId" });
    if (options.duplicateOfLeadId === lead.id) throw new ValidationError({ message: "A lead cannot duplicate itself.", field: "duplicateOfLeadId" });
    const original = await tx.lead.findFirst({ where: { id: options.duplicateOfLeadId, tenantId: actor.tenantId }, select: { id: true } });
    if (!original) throw new ValidationError({ message: "The lead to duplicate was not found.", field: "duplicateOfLeadId" });
  }

  const now = new Date();
  const updated = await tx.lead.updateMany({
    where: { id: lead.id, tenantId: actor.tenantId, status: lead.status },
    data: {
      status: to,
      statusChangedAt: now,
      closedReason: REASON_REQUIRED_STATUSES.includes(to) ? reason : null,
      duplicateOfLeadId: to === "DUPLICATE" ? options.duplicateOfLeadId : null,
    },
  });
  if (updated.count === 0) throw new ConflictError({ message: "The lead was changed by someone else. Reload it and try again." });

  await tx.leadStatusHistory.create({
    data: { tenantId: actor.tenantId, leadId: lead.id, fromStatus: lead.status, toStatus: to, actorType: "USER", actorUserId: actor.userId, reason, occurredAt: now },
  });

  // Closing or releasing a lead ends its owner's assignment: ASSIGNED scope must not outlive the work (customers README).
  if (isClosedStatus(to) || to === "UNASSIGNED") {
    await tx.leadAssignment.updateMany({
      where: { tenantId: actor.tenantId, leadId: lead.id, state: "ACTIVE" },
      data: { state: "ENDED", endedAt: now, endedReason: options.assignmentEndedReason ?? `lead status ${to}` },
    });
  }

  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "lead.status_change",
    targetType: "Lead",
    targetId: lead.id,
    previousValue: { status: lead.status },
    newValue: { status: to, ...(to === "DUPLICATE" ? { duplicateOfLeadId: options.duplicateOfLeadId } : {}) },
    reason: reason ?? undefined,
  });
}

/** True when `value` is one of the lead statuses (narrowing for values read from the database). */
export const isLeadStatus = (value: string): value is LeadStatusValue => (LEAD_STATUSES as readonly string[]).includes(value);
