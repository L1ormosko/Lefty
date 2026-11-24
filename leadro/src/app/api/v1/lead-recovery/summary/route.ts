import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { recoverySummary, summaryQuerySchema } from "@/server/recovery";

/** GET /api/v1/lead-recovery/summary: cases by status, CONFIRMED recovered revenue and ESTIMATED value of open cases, per currency, never added together. Permission: `recovery.view`. */
export const GET = defineRoute({
  schemas: { query: summaryQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view"),
  handler: async ({ ctx, input }) => ok(await recoverySummary(actorOf(ctx), input.query)),
});
