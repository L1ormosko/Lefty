import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { getRule, ruleIdParams, updateRule, updateRuleSchema } from "@/server/recovery";
import { resolveRule } from "../../_lib/resolvers";

/** GET /api/v1/lead-recovery/rules/{id}. Permission: `recovery.view` over the rule's unit. */
export const GET = defineRoute({
  schemas: { params: ruleIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view", resolveRule),
  handler: async ({ ctx, input }) => ok(await getRule(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/lead-recovery/rules/{id}: edits a DRAFT in place; anything else needs a new version. Permission: `recovery.manage`. */
export const PATCH = defineRoute({
  schemas: { params: ruleIdParams, body: updateRuleSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.manage", resolveRule),
  handler: async ({ ctx, input }) => ok(await updateRule(actorOf(ctx), ctx, input.params.id, input.body)),
});
