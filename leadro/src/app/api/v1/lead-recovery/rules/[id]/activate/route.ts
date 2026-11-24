import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { activateRule, ruleDecisionSchema, ruleIdParams } from "@/server/recovery";
import { resolveRule } from "../../../_lib/resolvers";

/**
 * POST /api/v1/lead-recovery/rules/{id}/activate: activates a rule. A high-impact rule is approved here by `recovery.approve`
 * (never its author); any other rule needs `recovery.manage`. The route gates on `recovery.view` and the service enforces the
 * permission that depends on the rule.
 */
export const POST = defineRoute({
  schemas: { params: ruleIdParams, body: ruleDecisionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view", resolveRule),
  handler: async ({ ctx, input }) => ok(await activateRule(actorOf(ctx), ctx, input.params.id, input.body)),
});
