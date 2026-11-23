import { registerJobOutcomeNotificationTarget } from "@/server/job-outcomes";
import { registerJobNotificationTarget } from "@/server/jobs";
import { registerLeadNotifications } from "@/server/leads";

/**
 * The ONE place that teaches the notifications engine how to authorize the records its notifications link to
 * (read-time access check, `redactInaccessible`). Both `src/instrumentation.ts` (server start) and the notifications
 * route module import it, so the resolvers are registered no matter which entry point loads first. The registry
 * itself lives on `globalThis` (see `notifications/target-access.ts`), because Next.js bundles instrumentation and
 * routes separately. Add a line here for every new notification target type; each call must be idempotent.
 */
export function registerNotificationTargets(): void {
  registerLeadNotifications();
  registerJobNotificationTarget();
  registerJobOutcomeNotificationTarget();
}

registerNotificationTargets();
