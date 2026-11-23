import type { Prisma } from "@prisma/client";
import { canTransitionFollowUp, isFollowUpStatus, type FollowUpStatusValue } from "@/lib/follow-up-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { assertFollowUpAccess, lockFollowUp } from "./access";
import { runFieldWrite, type FieldWriteOutcome } from "./offline";
import { viewAfterWrite, getFollowUpInTx } from "./read";
import type { CancelFollowUpInput, ChangeFollowUpStatusInput, CompleteFollowUpInput } from "./schemas";

/**
 * Status changes of a follow-up (§5.9). The machine is `src/lib/follow-up-lifecycle.ts`; this file applies it. Every
 * change needs `follow_ups.edit` over the task (both access gates) and takes the task row lock first, so two people
 * acting on the same task queue up and the second sees the first one's result (and is refused if it no longer fits).
 * The work is a field action, so each endpoint also accepts the offline fields (`runFieldWrite`).
 */

interface Change {
  to: FollowUpStatusValue;
  /** DONE: optional completion note. */
  note?: string;
  /** CANCELLED: required reason. */
  reason?: string;
}

/** Columns that depend on the target status. Leaving DONE / CANCELLED (reopen) clears their stamps. */
function statusColumns(change: Change, actor: Actor, occurredAt: Date): Prisma.FollowUpTaskUncheckedUpdateInput {
  const cleared = { completedAt: null, completedById: null, completionNote: null, cancelledAt: null, cancelReason: null };
  switch (change.to) {
    case "DONE":
      return { status: "DONE", completedAt: occurredAt, completedById: actor.userId, completionNote: change.note?.trim() || null };
    case "CANCELLED":
      return { status: "CANCELLED", cancelledAt: occurredAt, cancelReason: change.reason?.trim() };
    case "OPEN":
      // Reopened work starts a fresh reminder cycle.
      return { status: "OPEN", ...cleared, dueSoonNotifiedAt: null, overdueNotifiedAt: null };
    case "IN_PROGRESS":
      return { status: "IN_PROGRESS" };
  }
}

async function applyChange(
  tx: TenantTx,
  actor: Actor,
  ctx: RequestContext,
  followUpId: string,
  change: Change,
  occurredAt: Date,
): Promise<FieldWriteOutcome<Record<string, unknown>>> {
  await assertFollowUpAccess(tx, actor, followUpId, "follow_ups.edit");
  await lockFollowUp(tx, actor.tenantId, followUpId);
  // Re-read after the lock: the status may have changed while we waited for it.
  const current = await tx.followUpTask.findFirst({ where: { id: followUpId, tenantId: actor.tenantId }, select: { status: true } });
  if (!current || !isFollowUpStatus(current.status)) throw new NotFoundError();
  if (!canTransitionFollowUp(current.status, change.to)) {
    throw new InvalidStateTransitionError({ message: `A ${current.status} follow-up cannot become ${change.to}.` });
  }
  await tx.followUpTask.update({ where: { id: followUpId }, data: statusColumns(change, actor, occurredAt) });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "follow_up.status_change",
    targetType: "FollowUpTask",
    targetId: followUpId,
    previousValue: { status: current.status },
    // The note and the reason are free text: the trail records that they exist.
    newValue: { status: change.to, hasNote: Boolean(change.note), hasReason: Boolean(change.reason), occurredAt },
  });
  return { entityType: "FollowUpTask", entityId: followUpId, value: await viewAfterWrite(tx, actor, followUpId), notificationIds: [] };
}

function runChange(
  actor: Actor,
  ctx: RequestContext,
  followUpId: string,
  type: string,
  change: Change,
  offline: { clientEventId?: string; occurredAt?: Date },
): Promise<Record<string, unknown>> {
  return runFieldWrite(
    actor,
    offline,
    { type, content: { followUpId, ...change }, payload: { followUpId, status: change.to } },
    (tx, occurredAt) => applyChange(tx, actor, ctx, followUpId, change, occurredAt),
    (tx, entityId) => getFollowUpInTx(tx, actor, entityId),
  );
}

/** Starts work (IN_PROGRESS), puts it back (OPEN), or reopens a DONE / CANCELLED task (OPEN). */
export function changeFollowUpStatus(actor: Actor, ctx: RequestContext, followUpId: string, input: ChangeFollowUpStatusInput) {
  const { clientEventId, occurredAt, status } = input;
  return runChange(actor, ctx, followUpId, status === "IN_PROGRESS" ? "follow_up.start" : "follow_up.reopen", { to: status }, { clientEventId, occurredAt });
}

/** Marks the task DONE. `completedAt` is the device time of the action when it was recorded offline. */
export function completeFollowUp(actor: Actor, ctx: RequestContext, followUpId: string, input: CompleteFollowUpInput) {
  const { clientEventId, occurredAt, note } = input;
  return runChange(actor, ctx, followUpId, "follow_up.complete", { to: "DONE", note }, { clientEventId, occurredAt });
}

/** Cancels the task; the reason is mandatory and kept. */
export function cancelFollowUp(actor: Actor, ctx: RequestContext, followUpId: string, input: CancelFollowUpInput) {
  const { clientEventId, occurredAt, reason } = input;
  return runChange(actor, ctx, followUpId, "follow_up.cancel", { to: "CANCELLED", reason }, { clientEventId, occurredAt });
}
