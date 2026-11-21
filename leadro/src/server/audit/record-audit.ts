import type { Prisma } from "@prisma/client";
import { redactSensitive } from "@/lib/redact";
import type { RequestContext, SourceApp } from "@/server/core";
import type { TenantTx } from "@/server/db";

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILED";

/** One audit event (§21.2). Values are redacted by `recordAudit`; callers pass raw data. */
export interface AuditEventInput {
  tenantId: string;
  /** Null for system-originated events (jobs, migrations). */
  actorUserId: string | null;
  /** `resource.verb`, e.g. `employee.update`, `auth.login`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Changed fields only, where meaningful. */
  previousValue?: unknown;
  newValue?: unknown;
  /** Required by the caller for sensitive actions. */
  reason?: string;
  /** Denied and failed attempts are recorded too, not just successes. */
  outcome?: AuditOutcome;
  sourceApp: SourceApp;
  correlationId?: string;
  ipAddress?: string;
}

/** Fields every request-scoped audit event shares; spread it into the event you build. */
export type AuditContextFields = Pick<AuditEventInput, "tenantId" | "actorUserId" | "sourceApp" | "correlationId">;

/**
 * Derives tenant, actor, source app and correlation id from the request context.
 * Throws for unauthenticated contexts: use an explicit `tenantId` for events like failed logins.
 */
export function auditContextFields(ctx: RequestContext): AuditContextFields {
  if (!ctx.actor) throw new Error("auditContextFields requires an authenticated actor");
  return {
    tenantId: ctx.actor.tenantId,
    actorUserId: ctx.actor.userId,
    sourceApp: ctx.sourceApp,
    correlationId: ctx.correlationId,
  };
}

function toJsonColumn(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return redactSensitive(value) as Prisma.InputJsonValue;
}

/**
 * Appends an audit event using the caller's transaction `tx`, so the event commits or rolls back
 * together with the change it describes (§21, CODING_STANDARDS "Data access").
 *
 * Previous/new values are deep-redacted first: password hashes, MFA secrets and tokens never
 * reach the table. The table is append-only (DB trigger), so a mistake here cannot be fixed later,
 * which is why redaction happens inside this function and not at call sites.
 *
 * @returns the id of the stored event.
 */
export async function recordAudit(tx: TenantTx, event: AuditEventInput): Promise<string> {
  const created = await tx.auditEvent.create({
    data: {
      tenantId: event.tenantId,
      actorType: event.actorUserId ? "USER" : "SYSTEM",
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      previousValue: toJsonColumn(event.previousValue),
      newValue: toJsonColumn(event.newValue),
      reason: event.reason,
      outcome: event.outcome ?? "SUCCESS",
      sourceApp: event.sourceApp,
      correlationId: event.correlationId,
      ipAddress: event.ipAddress,
    },
    select: { id: true },
  });
  return created.id;
}
