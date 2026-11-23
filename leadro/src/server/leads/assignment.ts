import { isClosedStatus, isOwnedStatus } from "@/lib/lead-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { activePlacementWhere, canInTx, enforceInTx, type ResourceRef } from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  conflictOnUniqueViolation,
  type Actor,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit, notifyInTx } from "@/server/notifications";
import { orgUnitAncestry } from "@/server/qualifications";
import { findOpenContactAttempts } from "./interactions";
import { leadResourceRef, lockLead } from "./lead-access";
import { leadViewAfterWrite } from "./lead-view";
import type { AssignLeadInput, UnassignLeadInput } from "./schemas";
import { applyLeadStatus, isLeadStatus } from "./status-change";

/**
 * Lead assignment (§6.2 "current owner", §25.1). The owner is the lead's ACTIVE `LeadAssignment`; at most one exists
 * (partial unique index). Needs `leads.assign` over the lead.
 *
 * Who may be assigned: an ACTIVE employee (not on leave, not terminated) with a current placement and an active login
 * who could actually work the lead (`leads.view` over it once assigned). "Lead assigned to unavailable employee" and
 * "lead assigned to wrong region" (§25.1) are refused / confirmed here instead of silently creating a lead nobody works.
 *
 * Conflict rule (§25.1 "lead reassigned while another employee is contacting the customer"): when a contact attempt of
 * ANOTHER employee than the new owner is open, the assignment is refused (409) until the assigner repeats it with
 * `confirmOpenContactAttempt: true` and a reason. The confirmation is stored on the assignment row
 * (`conflictConfirmed`), the other person's open attempts are closed (the history of what they did is kept), and the
 * audit event names them. Replacing an existing owner always needs a reason.
 */

const openAttemptsConflict = (): ConflictError =>
  new ConflictError({
    message: "Another employee has an open contact attempt on this lead. Confirm the change and give a reason to continue.",
    field: "confirmOpenContactAttempt",
  });

interface Assignee {
  id: string;
  userId: string;
}

/** The employee must be able to take the lead; the failure names the field, never another tenant's data. */
async function loadAssignee(tx: TenantTx, actor: Actor, employeeId: string, ref: ResourceRef): Promise<Assignee & { placementUnitIds: string[] }> {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId: actor.tenantId },
    select: {
      id: true,
      status: true,
      userId: true,
      assignments: { where: activePlacementWhere(new Date()), select: { orgUnitId: true } },
    },
  });
  if (!employee) throw new ValidationError({ message: "Employee not found.", field: "employeeId" });
  if (employee.status !== "ACTIVE") {
    throw new ValidationError({ message: "This employee is not available (on leave or terminated).", field: "employeeId" });
  }
  if (employee.assignments.length === 0) {
    throw new ValidationError({ message: "This employee has no current placement in the organization.", field: "employeeId" });
  }
  if (!employee.userId) throw new ValidationError({ message: "This employee has no login and cannot work leads.", field: "employeeId" });

  const view = await canInTx(tx, { tenantId: actor.tenantId, userId: employee.userId }, "leads.view", {
    ...ref,
    assignedEmployeeIds: [employee.id],
  });
  if (!view.allowed) {
    throw new ValidationError({ message: "This employee would not be able to see the lead.", field: "employeeId" });
  }
  return { id: employee.id, userId: employee.userId, placementUnitIds: employee.assignments.map((placement) => placement.orgUnitId) };
}

/** True when one of the employee's placements is the lead's unit, above it or below it ("same region"). */
async function worksInServiceArea(tx: TenantTx, tenantId: string, leadUnitId: string | null, placementUnitIds: string[]): Promise<boolean> {
  if (!leadUnitId) return true; // an unrouted lead has no region to be wrong about
  const leadAncestry = await orgUnitAncestry(tx, tenantId, leadUnitId);
  for (const unitId of placementUnitIds) {
    if (leadAncestry.includes(unitId)) return true; // the employee's unit is the lead's unit or one of its parents
    if ((await orgUnitAncestry(tx, tenantId, unitId)).includes(leadUnitId)) return true; // the lead's unit is above the employee's
  }
  return false;
}

/** Ends the open attempts that were still running (history stays: only `closedAt` is set). Returns their ids. */
async function closeOpenAttempts(tx: TenantTx, tenantId: string, attemptIds: string[], now: Date): Promise<void> {
  if (attemptIds.length === 0) return;
  await tx.leadInteraction.updateMany({
    where: { tenantId, id: { in: attemptIds }, closedAt: null, occurredAt: { lte: now } },
    data: { closedAt: now },
  });
}

/** Gives the lead to `input.employeeId` (first assignment or reassignment). See the module comment for the rules. */
export async function assignLead(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: AssignLeadInput,
): Promise<Record<string, unknown>> {
  let notificationIds: string[] = [];
  const view = await conflictOnUniqueViolation("The lead was assigned by another request. Reload it and try again.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "leads.assign");
      const ref = await leadResourceRef(tx, actor.tenantId, leadId);
      if (!ref) throw new NotFoundError();
      await enforceInTx(tx, actor, "leads.assign", ref);
      await lockLead(tx, actor.tenantId, leadId);

      const lead = await tx.lead.findFirst({
        where: { id: leadId, tenantId: actor.tenantId },
        select: { id: true, number: true, status: true, archivedAt: true, orgUnitId: true },
      });
      if (!lead || !isLeadStatus(lead.status)) throw new NotFoundError();
      if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be assigned. Restore it first." });
      if (isClosedStatus(lead.status)) throw new InvalidStateTransitionError({ message: `A ${lead.status} lead cannot be assigned. Reopen it first.` });

      const assignee = await loadAssignee(tx, actor, input.employeeId, ref);
      const current = await tx.leadAssignment.findFirst({
        where: { tenantId: actor.tenantId, leadId, state: "ACTIVE" },
        select: { id: true, employeeId: true },
      });
      if (current?.employeeId === assignee.id) throw new InvalidStateTransitionError({ message: "The lead is already assigned to this employee." });

      const now = new Date();
      // §25.1: an open attempt of somebody else than the new owner.
      const openAttempts = (await findOpenContactAttempts(tx, actor.tenantId, leadId, now)).filter((attempt) => attempt.authorId !== assignee.userId);
      if (openAttempts.length > 0 && !input.confirmOpenContactAttempt) throw openAttemptsConflict();
      const conflictConfirmed = openAttempts.length > 0;

      // §25.1 wrong region: the assignee works outside the lead's service area.
      const inArea = await worksInServiceArea(tx, actor.tenantId, lead.orgUnitId, assignee.placementUnitIds);
      if (!inArea && !input.confirmOutsideServiceArea) {
        throw new ValidationError({
          message: "This employee works outside the lead's service area. Confirm to assign anyway.",
          field: "confirmOutsideServiceArea",
        });
      }
      if ((current || conflictConfirmed || !inArea) && !input.reason) {
        throw new ValidationError({ message: "A reason is required to replace an owner or to confirm a conflict.", field: "reason" });
      }

      if (current) {
        const ended = await tx.leadAssignment.updateMany({
          where: { id: current.id, tenantId: actor.tenantId, state: "ACTIVE" },
          data: { state: "ENDED", endedAt: now, endedReason: `reassigned: ${input.reason}` },
        });
        if (ended.count === 0) throw new ConflictError({ message: "The lead was reassigned by someone else. Reload it and try again." });
      }
      const assignment = await tx.leadAssignment.create({
        data: {
          tenantId: actor.tenantId,
          leadId,
          employeeId: assignee.id,
          assignedAt: now,
          assignedById: actor.userId,
          reason: input.reason ?? null,
          conflictConfirmed,
        },
        select: { id: true },
      });
      await closeOpenAttempts(tx, actor.tenantId, openAttempts.map((attempt) => attempt.id), now);
      if (lead.status === "NEW" || lead.status === "UNASSIGNED") {
        await applyLeadStatus(tx, actor, ctx, { id: lead.id, status: lead.status }, "ASSIGNED", { reason: input.reason ?? "assigned" });
      }

      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "lead.assign",
        targetType: "Lead",
        targetId: leadId,
        previousValue: { employeeId: current?.employeeId ?? null },
        newValue: {
          employeeId: assignee.id,
          assignmentId: assignment.id,
          conflictConfirmed,
          outsideServiceAreaConfirmed: !inArea,
          closedOpenAttemptIds: openAttempts.map((attempt) => attempt.id),
        },
        reason: input.reason,
      });

      if (assignee.userId !== actor.userId) {
        const newRef = await leadResourceRef(tx, actor.tenantId, leadId);
        const result = await notifyInTx(tx, {
          tenantId: actor.tenantId,
          eventType: "lead.assigned",
          eventId: `${leadId}:assigned:${assignment.id}`,
          recipientUserIds: [assignee.userId],
          params: { leadNumber: lead.number },
          target: { targetType: "lead", targetId: leadId, permission: "leads.view", resource: newRef ?? { assignedEmployeeIds: [assignee.id] } },
        });
        notificationIds = result.createdNotificationIds;
      }
      return leadViewAfterWrite(tx, actor, leadId);
    }),
  );
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}

/**
 * Releases the lead's owner: the lead goes back to the pool (UNASSIGNED). A reason is required. Open contact attempts
 * (§25.1) need the same explicit confirmation as a reassignment, and are closed when it is given.
 */
export async function unassignLead(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: UnassignLeadInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.assign");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "leads.assign", ref);
    await lockLead(tx, actor.tenantId, leadId);

    const lead = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { id: true, status: true, archivedAt: true } });
    if (!lead || !isLeadStatus(lead.status)) throw new NotFoundError();
    if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be changed. Restore it first." });
    const owner = await tx.leadAssignment.findFirst({ where: { tenantId: actor.tenantId, leadId, state: "ACTIVE" }, select: { id: true, employeeId: true } });
    if (!owner || !isOwnedStatus(lead.status)) throw new InvalidStateTransitionError({ message: "The lead has no owner to release." });

    const now = new Date();
    const openAttempts = await findOpenContactAttempts(tx, actor.tenantId, leadId, now);
    // The owner's OWN open attempt is not a conflict: they are the one releasing the lead (it is closed with the release).
    const ownerUserId = (await tx.employee.findFirst({ where: { id: owner.employeeId, tenantId: actor.tenantId }, select: { userId: true } }))?.userId;
    const othersAttempts = openAttempts.filter((attempt) => attempt.authorId !== ownerUserId);
    if (othersAttempts.length > 0 && !input.confirmOpenContactAttempt) throw openAttemptsConflict();

    await applyLeadStatus(tx, actor, ctx, { id: lead.id, status: lead.status }, "UNASSIGNED", {
      reason: input.reason,
      assignmentEndedReason: `unassigned: ${input.reason}`,
    });
    await closeOpenAttempts(tx, actor.tenantId, openAttempts.map((attempt) => attempt.id), now);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.unassign",
      targetType: "Lead",
      targetId: leadId,
      previousValue: { employeeId: owner.employeeId },
      newValue: { employeeId: null, conflictConfirmed: othersAttempts.length > 0, closedOpenAttemptIds: openAttempts.map((attempt) => attempt.id) },
      reason: input.reason,
    });
    return leadViewAfterWrite(tx, actor, leadId);
  });
}
