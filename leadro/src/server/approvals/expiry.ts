import { hasExpired } from "@/lib/approval-rules";
import { prisma, withTenant } from "@/server/db";
import { logger } from "@/server/logging";
import { deliverAfterCommit } from "@/server/notifications";
import { loadRequestRow, lockRequest } from "./access";
import { finishRequestInTx } from "./finish";

/**
 * Expiry (§21.3): a request whose policy set `expiresAfterHours` ends as EXPIRED once `expiresAt` passes. There is no
 * scheduler in the system yet, so the sweep is a plain function for a worker (or a test) to call. Between `expiresAt` and the
 * sweep, the request is already treated as closed: it leaves the approver queue, and deciding or cancelling it expires it
 * on the spot (409). Each request expires in its own transaction, so one failing subject handler cannot block the others.
 */

const BATCH = 200;

/**
 * Expires one request if it is still PENDING and past its `expiresAt` (system actor, subject handler `onRejected` with
 * outcome EXPIRED). Safe to call concurrently: the row lock and the status guard let exactly one caller expire it.
 * @returns whether this call expired it.
 */
export async function expireApprovalRequest(tenantId: string, requestId: string, now: Date = new Date()): Promise<boolean> {
  const result = await withTenant(tenantId, async (tx) => {
    await lockRequest(tx, tenantId, requestId);
    const row = await loadRequestRow(tx, tenantId, requestId);
    if (!row || row.status !== "PENDING" || !hasExpired(row.expiresAt, now)) return null;
    return finishRequestInTx(tx, null, row, { outcome: "EXPIRED", reason: null, now });
  });
  if (!result) return false;
  await deliverAfterCommit(tenantId, result.notificationIds);
  return true;
}

/** Sweeps one tenant: expires up to one batch of overdue PENDING requests. Returns how many were expired. */
export async function expireDueApprovalRequests(tenantId: string, now: Date = new Date()): Promise<number> {
  const due = await withTenant(tenantId, (tx) =>
    tx.approvalRequest.findMany({
      where: { tenantId, status: "PENDING", expiresAt: { lte: now } },
      select: { id: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: BATCH,
    }),
  );
  let expired = 0;
  for (const { id } of due) {
    try {
      if (await expireApprovalRequest(tenantId, id, now)) expired += 1;
    } catch (error) {
      logger.error("approval request expiry failed", { tenantId, requestId: id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return expired;
}

/** The periodic worker entry: one sweep over every tenant (or only `tenantIds`). A failing tenant is logged and skipped. */
export async function expireDueApprovalRequestsForAllTenants(options: { now?: Date; tenantIds?: readonly string[] } = {}): Promise<number> {
  const tenants = await prisma.tenant.findMany({ where: options.tenantIds ? { id: { in: [...options.tenantIds] } } : {}, select: { id: true } });
  let total = 0;
  for (const tenant of tenants) {
    try {
      total += await expireDueApprovalRequests(tenant.id, options.now);
    } catch (error) {
      logger.error("approval expiry sweep failed for a tenant", { tenantId: tenant.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return total;
}
