import { registerNotificationTargetResolver } from "@/server/notifications";
import { leadResourceRef } from "./lead-access";

/**
 * Teaches the notifications engine how to authorize a notification that links to a lead (§14): at read time it
 * re-checks the RECIPIENT's current `leads.view` on the lead, so losing the lead (reassigned, scope revoked) redacts
 * the notification instead of leaking the lead number. Registration is idempotent. It is called when this module
 * loads and from `src/instrumentation.ts` at server start (the notifications routes never import the leads module).
 */
export function registerLeadNotifications(): void {
  registerNotificationTargetResolver("lead", "leads.view", (tx, subject, leadId) => leadResourceRef(tx, subject.tenantId, leadId));
}
