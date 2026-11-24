import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { newRuleVersion, ruleIdParams } from "@/server/recovery";
import { resolveRule } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/rules/{id}/new-version: copies the rule into a new DRAFT version (version + 1). Permission: `recovery.manage`. */
export const POST = defineRoute({
  schemas: { params: ruleIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.manage", resolveRule),
  handler: async ({ ctx, input }) => created(await newRuleVersion(actorOf(ctx), ctx, input.params.id)),
});
