import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getReconciliationException, reconciliationIdParams } from "@/server/reconciliation";
import { resolveReconciliationException } from "../../../_lib/resolve";

/** GET /api/v1/finance/reconciliation/exceptions/{id}: one exception. */
export const GET = defineRoute({
  schemas: { params: reconciliationIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view", resolveReconciliationException),
  handler: async ({ ctx, input }) => ok(await getReconciliationException(actorOf(ctx), input.params.id)),
});
