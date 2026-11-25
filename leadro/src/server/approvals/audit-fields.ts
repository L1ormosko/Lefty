import type { AuditContextFields } from "@/server/audit";
import type { RequestContext } from "@/server/core";

/**
 * Audit fields for engine writes that may run with or without a person: a request context with an actor gives the usual
 * fields; no context (the expiry sweep, a system-raised request) is recorded as a SYSTEM event of `tenantId`.
 */
export function systemAuditFields(tenantId: string, ctx: RequestContext | null): AuditContextFields {
  return {
    tenantId,
    actorUserId: ctx?.actor?.userId ?? null,
    sourceApp: ctx?.actor ? ctx.sourceApp : "SYSTEM",
    correlationId: ctx?.correlationId,
  };
}
