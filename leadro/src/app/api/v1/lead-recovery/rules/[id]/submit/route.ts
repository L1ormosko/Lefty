import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { ruleIdParams, submitRule } from "@/server/recovery";
import { resolveRule } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/rules/{id}/submit: DRAFT -> PENDING_APPROVAL for a high-impact rule. Permission: `recovery.manage`. */
export const POST = defineRoute({
  schemas: { params: ruleIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.manage", resolveRule),
  handler: async ({ ctx, input }) => ok(await submitRule(actorOf(ctx), ctx, input.params.id)),
});
