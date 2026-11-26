import { registerApprovalNotificationTarget } from "@/server/approvals";
import { registerFinanceAdjustments } from "@/server/finance-adjustments";
import { registerFollowUpNotificationTarget } from "@/server/follow-ups";
import { registerJobOutcomeNotificationTarget } from "@/server/job-outcomes";
import { registerJobNotificationTarget } from "@/server/jobs";
import { registerLeadNotifications } from "@/server/leads";
import { registerMaterialCostApprovalSubject } from "@/server/materials";
import { registerRecoveryEngine, registerRecoveryFollowUpTarget, registerRecoveryNotificationTarget } from "@/server/recovery";
import { registerTrainingNotificationTargets } from "@/server/training";

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
  registerFollowUpNotificationTarget();
  registerJobOutcomeNotificationTarget();
  // Lead recovery: the case notification resolver, the follow-up target access, and the outcome subscription (the engine).
  registerRecoveryNotificationTarget();
  registerRecoveryFollowUpTarget();
  registerRecoveryEngine();
  // Approvals: notifications that link to a request. Subject modules add their `registerApprovalSubject(...)` call here too.
  registerApprovalNotificationTarget();
  registerMaterialCostApprovalSubject();
  // Refunds, adjustments, chargeback write-offs (approval subjects), provider chargebacks (intake) and the finance review
  // reactions to a reopened job or a corrected outcome.
  registerFinanceAdjustments();
  // Training assignments and records (assigned / overdue / expiring / expired notifications).
  registerTrainingNotificationTargets();
}

registerNotificationTargets();
