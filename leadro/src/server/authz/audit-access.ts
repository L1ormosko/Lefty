import { listAuditEvents, type AuditPage, type ListAuditEventsOptions } from "@/server/audit";
import { ForbiddenError, type Actor } from "@/server/core";
import { can } from "./can";

/**
 * The permission-checked way to read the audit log (`listAuditEvents` itself does no check).
 * The audit log is tenant-level data, so `audit.view` must carry a TENANT scope: a manager scoped
 * to a city never sees the company-wide log.
 */
export async function listAuditEventsAsActor(actor: Actor, options: ListAuditEventsOptions = {}): Promise<AuditPage> {
  const decision = await can(actor, "audit.view", {});
  if (!decision.allowed) throw new ForbiddenError();
  return listAuditEvents(actor.tenantId, options);
}
