import { changedFields } from "@/lib/changed-fields";
import { isFollowUpStatus, isOpenFollowUpStatus } from "@/lib/follow-up-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { assertFollowUpAccess, lockFollowUp, loadFollowUpRow } from "./access";
import { validateAssignee } from "./assignee";
import { followUpRowSelect, targetIdOf } from "./fields";
import { notifyFollowUpAssignee } from "./notify";
import { viewAfterWrite } from "./read";
import type { AssignFollowUpInput, UpdateFollowUpInput } from "./schemas";

/**
 * Editing and assigning follow-ups. Both work on OPEN / IN_PROGRESS tasks only: a finished or cancelled task is a
 * record of what happened and is reopened (status endpoint) before it changes.
 */

/**
 * Edits title, description, due date and priority (`follow_ups.edit`). A changed due date starts a fresh reminder cycle
 * (the due-soon / overdue stamps are cleared), so the sweep notifies against the NEW time.
 */
export async function updateFollowUp(actor: Actor, ctx: RequestContext, followUpId: string, input: UpdateFollowUpInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertFollowUpAccess(tx, actor, followUpId, "follow_ups.edit");
    await lockFollowUp(tx, actor.tenantId, followUpId);
    const current = await loadFollowUpRow(tx, actor.tenantId, followUpId);
    if (!current) throw new NotFoundError();
    if (!isFollowUpStatus(current.status) || !isOpenFollowUpStatus(current.status)) {
      throw new InvalidStateTransitionError({ message: `A ${current.status} follow-up cannot be edited. Reopen it first.` });
    }
    const patch = { ...input, ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}) };
    const { changedKeys, previous, next } = changedFields(current, patch);
    if (changedKeys.length === 0) return viewAfterWrite(tx, actor, followUpId);

    await tx.followUpTask.update({
      where: { id: followUpId },
      data: { ...patch, ...(changedKeys.includes("dueAt") ? { dueSoonNotifiedAt: null, overdueNotifiedAt: null } : {}) },
    });
    // Title and description are free text: the trail names which fields changed, not what they now say.
    const isText = (key: string) => key === "title" || key === "description";
    const redact = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, isText(key) ? "[text]" : value]));
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "follow_up.update",
      targetType: "FollowUpTask",
      targetId: followUpId,
      previousValue: redact(previous),
      newValue: redact(next),
    });
    return viewAfterWrite(tx, actor, followUpId);
  });
}

/**
 * Assigns, reassigns or (with `assigneeId: null`) unassigns a task (`follow_ups.assign` over the task). The new assignee
 * must be within the caller's employee scope and able to work the task (`validateAssignee`) and is notified
 * (`follow_up.assigned`); the person assigning is never notified of their own action.
 */
export async function assignFollowUp(actor: Actor, ctx: RequestContext, followUpId: string, input: AssignFollowUpInput): Promise<Record<string, unknown>> {
  const { view, notificationIds } = await withTenant(actor.tenantId, async (tx) => {
    await assertFollowUpAccess(tx, actor, followUpId, "follow_ups.assign");
    await lockFollowUp(tx, actor.tenantId, followUpId);
    const current = await loadFollowUpRow(tx, actor.tenantId, followUpId);
    if (!current) throw new NotFoundError();
    if (!isFollowUpStatus(current.status) || !isOpenFollowUpStatus(current.status)) {
      throw new InvalidStateTransitionError({ message: `A ${current.status} follow-up cannot be reassigned. Reopen it first.` });
    }
    if (current.assigneeId === input.assigneeId) return { view: await viewAfterWrite(tx, actor, followUpId), notificationIds: [] };

    const assignee = input.assigneeId
      ? await validateAssignee(tx, actor, actor.tenantId, input.assigneeId, {
          targetType: current.targetType,
          targetId: targetIdOf(current),
          orgUnitId: current.orgUnitId,
          creatorEmployeeId: current.createdBy?.employee?.id ?? null,
        })
      : null;
    const now = new Date();
    await tx.followUpTask.update({
      where: { id: followUpId },
      data: { assigneeId: assignee?.employeeId ?? null, assignedAt: assignee ? now : null },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: assignee ? "follow_up.assign" : "follow_up.unassign",
      targetType: "FollowUpTask",
      targetId: followUpId,
      previousValue: { assigneeId: current.assigneeId },
      newValue: { assigneeId: assignee?.employeeId ?? null },
    });
    const updated = await tx.followUpTask.findFirstOrThrow({ where: { id: followUpId, tenantId: actor.tenantId }, select: followUpRowSelect });
    const ids = assignee ? await notifyFollowUpAssignee(tx, actor.tenantId, { eventType: "follow_up.assigned", row: updated, anchor: `assigned:${now.getTime()}`, excludeUserId: actor.userId }) : [];
    return { view: await viewAfterWrite(tx, actor, followUpId), notificationIds: ids };
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}
