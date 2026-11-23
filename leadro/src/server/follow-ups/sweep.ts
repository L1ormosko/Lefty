import type { Prisma } from "@prisma/client";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { logger } from "@/server/logging";
import { deliverAfterCommit } from "@/server/notifications";
import { followUpRowSelect } from "./fields";
import { notifyFollowUpAssignee } from "./notify";

/**
 * The follow-up sweep: raises "due soon" and "overdue" notifications (§5.9, §14.2). There is no scheduler in the system
 * yet, so this is a plain function for a worker (or a test) to call: `sweepFollowUps(tenantId)` for one tenant,
 * `sweepAllFollowUps()` for every tenant. It is safe to run as often and as concurrently as you like:
 *
 *  - each task is CLAIMED by stamping `dueSoonNotifiedAt` / `overdueNotifiedAt` with an atomic `UPDATE ... WHERE stamp IS NULL`,
 *    so two sweeps never notify the same task twice, and the notification itself is idempotent per task and due time;
 *  - only OPEN / IN_PROGRESS tasks with an assignee are notified (nobody to tell otherwise: such tasks stay in the
 *    `unassigned=true&overdue=true` queue and are picked up by the first sweep after somebody takes them);
 *  - "due soon" means due within the tenant's `OperationsSettings.followUpDueSoonMinutes` (default 60); a task that is
 *    already overdue gets only the overdue notification;
 *  - changing a due date or reopening a task clears its stamps, so the new time gets its own reminders.
 */

export const DEFAULT_DUE_SOON_MINUTES = 60;
/** Tasks handled per tenant and kind per run; the next run continues where this one stopped. */
const BATCH = 200;

export interface FollowUpSweepResult {
  dueSoon: number;
  overdue: number;
}

type Kind = "dueSoon" | "overdue";

/** Claims and notifies one kind of reminder for one tenant. Returns the notification ids created. */
async function sweepKind(tx: TenantTx, tenantId: string, kind: Kind, where: Prisma.FollowUpTaskWhereInput, now: Date): Promise<{ handled: number; notificationIds: string[] }> {
  const stamp = kind === "dueSoon" ? "dueSoonNotifiedAt" : "overdueNotifiedAt";
  const candidates = await tx.followUpTask.findMany({
    where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, assigneeId: { not: null }, [stamp]: null, ...where },
    select: { id: true },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: BATCH,
  });
  const notificationIds: string[] = [];
  let handled = 0;
  for (const { id } of candidates) {
    // The claim: only the sweep that flips the stamp from NULL notifies.
    const claim = await tx.followUpTask.updateMany({ where: { id, tenantId, [stamp]: null }, data: { [stamp]: now } });
    if (claim.count !== 1) continue;
    handled += 1;
    const row = await tx.followUpTask.findFirstOrThrow({ where: { id, tenantId }, select: followUpRowSelect });
    notificationIds.push(
      ...(await notifyFollowUpAssignee(tx, tenantId, {
        eventType: kind === "dueSoon" ? "follow_up.due_soon" : "follow_up.overdue",
        row,
        anchor: `${kind}:${row.dueAt.getTime()}`,
      })),
    );
  }
  return { handled, notificationIds };
}

/**
 * Sweeps one tenant as of `now`. Notifications are written in the sweep's transaction and delivered after it commits.
 * @returns how many tasks were claimed for each reminder (a claimed task whose assignee lost access is counted but not
 *   notified: the stamp prevents a retry loop).
 */
export async function sweepFollowUps(tenantId: string, now: Date = new Date()): Promise<FollowUpSweepResult> {
  const result = await withTenant(tenantId, async (tx) => {
    const settings = await tx.operationsSettings.findFirst({ where: { tenantId }, select: { followUpDueSoonMinutes: true } });
    const windowEnd = new Date(now.getTime() + (settings?.followUpDueSoonMinutes ?? DEFAULT_DUE_SOON_MINUTES) * 60_000);
    // Overdue first: a task counted overdue must never also be reported due soon in the same run.
    const overdue = await sweepKind(tx, tenantId, "overdue", { dueAt: { lt: now } }, now);
    const dueSoon = await sweepKind(tx, tenantId, "dueSoon", { dueAt: { gte: now, lte: windowEnd } }, now);
    return { overdue, dueSoon };
  });
  await deliverAfterCommit(tenantId, [...result.overdue.notificationIds, ...result.dueSoon.notificationIds]);
  return { dueSoon: result.dueSoon.handled, overdue: result.overdue.handled };
}

/** The periodic worker entry: one sweep over every tenant (or only `tenantIds`). A failing tenant is logged and skipped. */
export async function sweepAllFollowUps(options: { now?: Date; tenantIds?: readonly string[] } = {}): Promise<FollowUpSweepResult> {
  const tenants = await prisma.tenant.findMany({ where: options.tenantIds ? { id: { in: [...options.tenantIds] } } : {}, select: { id: true } });
  const total: FollowUpSweepResult = { dueSoon: 0, overdue: 0 };
  for (const tenant of tenants) {
    try {
      const result = await sweepFollowUps(tenant.id, options.now);
      total.dueSoon += result.dueSoon;
      total.overdue += result.overdue;
    } catch (error) {
      logger.error("follow-up sweep failed for a tenant", { tenantId: tenant.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return total;
}
