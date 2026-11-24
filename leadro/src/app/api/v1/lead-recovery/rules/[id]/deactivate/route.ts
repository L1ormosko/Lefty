import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { deactivateRule, ruleDecisionSchema, ruleIdParams } from "@/server/recovery";
import { resolveRule } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/rules/{id}/deactivate: ACTIVE -> INACTIVE (`recovery.manage`), or rejects a PENDING_APPROVAL rule (`recovery.approve`). */
export const POST = defineRoute({
  schemas: { params: ruleIdParams, body: ruleDecisionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view", resolveRule),
  handler: async ({ ctx, input }) => ok(await deactivateRule(actorOf(ctx), ctx, input.params.id, input.body)),
});
