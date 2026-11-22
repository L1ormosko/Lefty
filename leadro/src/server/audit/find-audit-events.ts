import type { Prisma } from "@prisma/client";
import type { TenantTx } from "@/server/db";

/** Which events to read: all given conditions must match; list fields match any of their values. */
export interface AuditEventQuery {
  tenantId: string;
  targetType?: string;
  /** Any of these actions (e.g. every unit change). */
  actions?: string[];
  /** Any of these targets; an empty list matches nothing (callers pass the ids they may see). */
  targetIds?: string[];
}

/** One audit row as module history readers need it (subset of the table, no network/session fields). */
export interface AuditHistoryRow {
  id: string;
  occurredAt: Date;
  action: string;
  targetId: string | null;
  actorUserId: string | null;
  previousValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  reason: string | null;
}

/** Same paging shape as `pageArgs` in core: one extra row tells the caller whether another page exists. */
export interface AuditPagingArgs {
  take: number;
  cursor?: { id: string };
  skip?: number;
}

/**
 * Reads audit events inside the caller's transaction, newest first, for the history screens that
 * are built on the audit trail (unit history). Authorization is the CALLER's job: it decides which
 * `targetIds` the actor may see before calling this; the rows themselves are tenant-isolated by RLS.
 *
 * This is the one place outside `listAuditEvents` that queries the audit table, so how audit rows
 * are read stays inside the audit module.
 */
export function findAuditHistoryInTx(tx: TenantTx, query: AuditEventQuery, paging: AuditPagingArgs): Promise<AuditHistoryRow[]> {
  const where: Prisma.AuditEventWhereInput = {
    tenantId: query.tenantId,
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.actions ? { action: { in: query.actions } } : {}),
    ...(query.targetIds ? { targetId: { in: query.targetIds } } : {}),
  };
  return tx.auditEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { id: true, occurredAt: true, action: true, targetId: true, actorUserId: true, previousValue: true, newValue: true, reason: true },
    ...paging,
  });
}
