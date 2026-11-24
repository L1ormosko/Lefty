import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, respond, defineRoute } from "@/server/core";
import { createRule, createRuleSchema, listRules, listRulesQuerySchema } from "@/server/recovery";

/** GET /api/v1/lead-recovery/rules: rules in the caller's scope, evaluation order, newest version of each key (`latestOnly=false` for all). Permission: `recovery.view`. */
export const GET = defineRoute({
  schemas: { query: listRulesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view"),
  handler: async ({ ctx, input }) => respond(200, await listRules(actorOf(ctx), input.query)),
});

/** POST /api/v1/lead-recovery/rules: a new DRAFT rule (version 1). `highImpact` is derived from its actions. Permission: `recovery.manage` over the rule's unit. */
export const POST = defineRoute({
  schemas: { body: createRuleSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createRule(actorOf(ctx), ctx, input.body)),
});
