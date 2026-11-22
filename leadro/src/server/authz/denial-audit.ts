import type { RequestContext } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { logger } from "@/server/logging";

/** The request facts a denial row carries; `defineRoute` passes a full RequestContext, web code a subset. */
export type DenialContext = Partial<Pick<RequestContext, "correlationId" | "sourceApp">>;

/**
 * Records a failed access (§21 "failed access") as an `authz.denied` audit event, in its own
 * transaction. Best effort: a failing audit write is logged and swallowed, so it can never turn a
 * denial into a success or a 500.
 *
 * `requirePermission` calls this for API routes. Code paths that enforce inside services (web
 * server actions, server-rendered pages) call it when they catch a Forbidden/NotFound, because the
 * enforcement helpers themselves stay silent (they run inside the caller's transaction, which a
 * denial would roll back).
 *
 * @param permission the permission key that was refused, or null when the refusing service did not say.
 * @param reason a short machine reason (an AccessReason); defaults to a generic service refusal.
 */
export async function recordAuthzDenial(
  actor: { tenantId: string; userId: string },
  permission: string | null,
  ctx?: DenialContext,
  reason = "DENIED_BY_SERVICE",
): Promise<void> {
  try {
    await withTenant(actor.tenantId, (tx) =>
      recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "authz.denied",
        targetType: "Permission",
        targetId: permission ?? undefined,
        newValue: { reason },
        outcome: "DENIED",
        // The correlation id lets a denial be found from the `x-correlation-id` the client received.
        sourceApp: ctx?.sourceApp ?? "API",
        correlationId: ctx?.correlationId,
      }),
    );
  } catch (error) {
    logger.error("failed to record authorization denial", { permission, error: String(error) });
  }
}
