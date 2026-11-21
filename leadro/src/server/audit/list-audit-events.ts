import type { Prisma } from "@prisma/client";
import { ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import type { AuditOutcome } from "./record-audit";

export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

export interface AuditEventFilter {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorUserId?: string;
  outcome?: AuditOutcome;
  /** Inclusive lower / exclusive upper bound on `occurredAt`. */
  from?: Date;
  to?: Date;
}

export interface ListAuditEventsOptions {
  filter?: AuditEventFilter;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface AuditEventView {
  id: string;
  occurredAt: Date;
  actorType: "USER" | "SYSTEM";
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  outcome: AuditOutcome;
  sourceApp: "WEB" | "MOBILE" | "API" | "SYSTEM";
  correlationId: string | null;
  ipAddress: string | null;
}

export interface AuditPage {
  data: AuditEventView[];
  page: { nextCursor: string | null; limit: number };
}

// Cursor = base64url("<occurredAt ISO>|<id>"): the keyset of the (occurredAt desc, id desc) order.
function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const occurredAt = new Date(iso ?? "");
  if (!id || Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError({ message: "The cursor is invalid.", field: "cursor" });
  }
  return { occurredAt, id };
}

/**
 * Audit timeline for ONE tenant, newest first, cursor-paginated (docs/API_CONVENTIONS.md).
 *
 * Tenant isolation: the query runs inside `withTenant(tenantId, ...)`, so row-level security
 * hides every other tenant's events even if a filter were wrong. Permission checks
 * (`audit.read`) are the caller's job; this function only reads.
 */
export async function listAuditEvents(tenantId: string, options: ListAuditEventsOptions = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? AUDIT_DEFAULT_PAGE_SIZE), 1), AUDIT_MAX_PAGE_SIZE);
  const { filter = {} } = options;

  const and: Prisma.AuditEventWhereInput[] = [];
  if (options.cursor) {
    const { occurredAt, id } = decodeCursor(options.cursor);
    and.push({ OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: id } }] });
  }
  const where: Prisma.AuditEventWhereInput = {
    tenantId,
    action: filter.action,
    targetType: filter.targetType,
    targetId: filter.targetId,
    actorUserId: filter.actorUserId,
    outcome: filter.outcome,
    occurredAt: filter.from || filter.to ? { gte: filter.from, lt: filter.to } : undefined,
    AND: and,
  };

  const rows = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one extra row tells us whether another page exists
    }),
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(({ tenantId: _tenantId, ...view }) => view),
    page: { nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null, limit },
  };
}
