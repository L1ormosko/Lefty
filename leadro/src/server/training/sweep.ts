import { prisma, withTenant, type TenantTx } from "@/server/db";
import { logger } from "@/server/logging";
import { deliverAfterCommit } from "@/server/notifications";
import { findExpiringTrainingRecords, findOverdueTrainingAssignments } from "./expiry";
import { notifyTraining } from "./notify";

/**
 * The training sweep: raises "overdue", "expiring" and "expired" notifications (§10.1, §14.2). There is no scheduler in
 * the system yet, so this is a plain function for a worker (or a test) to call: `sweepTraining(tenantId)` for one tenant,
 * `sweepAllTraining()` for every tenant. Safe to run as often and as concurrently as you like: every notification is
 * idempotent per record and occurrence (`<id>:overdue:<dueDate>`, `<id>:expiring:<expiresOn>`, `<id>:expired:<expiresOn>`),
 * so a re-run creates nothing new, and a changed due date or a renewal gets its own notification.
 *
 * Who hears what:
 *  - overdue assignment: the employee and whoever assigned it;
 *  - expiring (within the tenant's `qualificationWarningDays`) and expired completions (verified, not superseded by a
 *    longer-lasting one): the employee. "Expired" looks back `EXPIRED_LOOKBACK_DAYS` only, so a long-gone completion
 *    does not start notifying when the sweep first runs.
 * Recipients without `training.view` over the employee are dropped by the notification engine.
 */

/** Rows handled per query; the sweep pages through all of them. */
const BATCH = 500;
const EXPIRED_LOOKBACK_DAYS = 7;

export interface TrainingSweepResult {
  /** Notifications created (not rows looked at). */
  overdue: number;
  expiring: number;
  expired: number;
}

async function sweepOverdue(tx: TenantTx, tenantId: string, now: Date): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    const batch = await findOverdueTrainingAssignments(tx, tenantId, { now, take: BATCH, afterId });
    if (batch.length === 0) break;
    const employees = await tx.employee.findMany({ where: { tenantId, id: { in: batch.map((row) => row.employeeId) } }, select: { id: true, userId: true } });
    const userOf = new Map(employees.map((employee) => [employee.id, employee.userId]));
    for (const row of batch) {
      ids.push(
        ...(await notifyTraining(tx, tenantId, {
          eventType: "training.overdue",
          targetId: row.assignmentId,
          employeeId: row.employeeId,
          anchor: `overdue:${row.dueDate}`,
          recipientUserIds: [userOf.get(row.employeeId) ?? null, row.assignedById],
        })),
      );
    }
    afterId = batch[batch.length - 1].assignmentId;
  }
  return ids;
}

async function sweepExpiry(tx: TenantTx, tenantId: string, now: Date): Promise<{ expiring: string[]; expired: string[] }> {
  const result = { expiring: [] as string[], expired: [] as string[] };
  let afterId: string | undefined;
  for (;;) {
    const batch = await findExpiringTrainingRecords(tx, tenantId, { now, includeExpired: true, lookBackDays: EXPIRED_LOOKBACK_DAYS, take: BATCH, afterId });
    if (batch.length === 0) break;
    const employees = await tx.employee.findMany({ where: { tenantId, id: { in: batch.map((row) => row.employeeId) } }, select: { id: true, userId: true } });
    const userOf = new Map(employees.map((employee) => [employee.id, employee.userId]));
    for (const row of batch) {
      const expired = row.daysRemaining < 0;
      const created = await notifyTraining(tx, tenantId, {
        eventType: expired ? "training.expired" : "training.expiring",
        targetId: row.recordId,
        employeeId: row.employeeId,
        anchor: `${expired ? "expired" : "expiring"}:${row.expiresOn}`,
        recipientUserIds: [userOf.get(row.employeeId) ?? null],
      });
      (expired ? result.expired : result.expiring).push(...created);
    }
    afterId = batch[batch.length - 1].recordId;
  }
  return result;
}

/** Sweeps one tenant as of `now`. Notifications are written in one transaction and delivered after it commits. */
export async function sweepTraining(tenantId: string, now: Date = new Date()): Promise<TrainingSweepResult> {
  const result = await withTenant(tenantId, async (tx) => {
    const overdue = await sweepOverdue(tx, tenantId, now);
    const { expiring, expired } = await sweepExpiry(tx, tenantId, now);
    return { overdue, expiring, expired };
  });
  await deliverAfterCommit(tenantId, [...result.overdue, ...result.expiring, ...result.expired]);
  return { overdue: result.overdue.length, expiring: result.expiring.length, expired: result.expired.length };
}

/** The periodic worker entry: one sweep over every tenant (or only `tenantIds`). A failing tenant is logged and skipped. */
export async function sweepAllTraining(options: { now?: Date; tenantIds?: readonly string[] } = {}): Promise<TrainingSweepResult> {
  const tenants = await prisma.tenant.findMany({ where: options.tenantIds ? { id: { in: [...options.tenantIds] } } : {}, select: { id: true } });
  const total: TrainingSweepResult = { overdue: 0, expiring: 0, expired: 0 };
  for (const tenant of tenants) {
    try {
      const result = await sweepTraining(tenant.id, options.now);
      total.overdue += result.overdue;
      total.expiring += result.expiring;
      total.expired += result.expired;
    } catch (error) {
      logger.error("training sweep failed for a tenant", { tenantId: tenant.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return total;
}
