import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getReconciliationRun, reconciliationIdParams } from "@/server/reconciliation";
import { resolveReconciliationRun } from "../../../_lib/resolve";

/** GET /api/v1/finance/reconciliation/runs/{id}: one run, its totals and the exceptions it raised (counts). */
export const GET = defineRoute({
  schemas: { params: reconciliationIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view", resolveReconciliationRun),
  handler: async ({ ctx, input }) => ok(await getReconciliationRun(actorOf(ctx), input.params.id)),
});
