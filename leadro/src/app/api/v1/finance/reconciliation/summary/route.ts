import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getReconciliationSummary, summaryQuerySchema } from "@/server/reconciliation";

/** GET /api/v1/finance/reconciliation/summary: unresolved exceptions per kind and the latest completed runs, in scope. */
export const GET = defineRoute({
  schemas: { query: summaryQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view"),
  handler: async ({ ctx, input }) => ok(await getReconciliationSummary(actorOf(ctx), input.query)),
});
