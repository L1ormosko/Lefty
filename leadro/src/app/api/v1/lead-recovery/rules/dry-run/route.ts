import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { dryRunRule, dryRunSchema } from "@/server/recovery";

/** POST /api/v1/lead-recovery/rules/dry-run: evaluates a stored rule (`ruleId`) or an unsaved `definition` against a real not-converted outcome. Writes nothing. Permission: `recovery.manage`. */
export const POST = defineRoute({
  schemas: { body: dryRunSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.manage"),
  handler: async ({ ctx, input }) => ok(await dryRunRule(actorOf(ctx), input.body)),
});
