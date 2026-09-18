import "server-only";

import type { AuditAction } from "@prisma/client";
import { prisma } from "./db";

/**
 * Record that something consequential happened.
 *
 * Two rules, and the second one is the important one.
 *
 * 1. Only actions that change someone else's standing: an admin verifying a
 *    listing, switching an account off, recording a subscription; an owner
 *    publishing or taking down inventory; a booking decided or cancelled. A
 *    log that records everything gets read by nobody.
 *
 * 2. **Writing the log must never break the thing being logged.** A failure
 *    here is swallowed and reported to the server logs, exactly as
 *    server/email.ts treats a missing provider: a booking that was approved
 *    has been approved, and rolling that back because an audit row would not
 *    insert would turn a bookkeeping problem into a commercial one. The
 *    trade-off is explicit - this is a moderation and support aid, not a
 *    tamper-proof ledger, and it is not load-bearing for any guarantee.
 *
 * Never put a secret, a password hash, a session token or a whole record in
 * `summary`. It is one line, meant to be read by a human in a list.
 */
export async function recordAudit(entry: {
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  summary?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        summary: entry.summary?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    console.error("[velto] audit write failed:", entry.action, entry.targetId, err);
  }
}

/** Most recent entries, newest first, for the admin screen. */
export async function recentAudit(limit = 50, skip = 0) {
  return prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    skip,
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  });
}

export async function countAudit(): Promise<number> {
  return prisma.auditLog.count();
}
