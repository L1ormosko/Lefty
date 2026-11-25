import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { assignExceptionSchema, assignReconciliationException, reconciliationIdParams } from "@/server/reconciliation";
import { resolveReconciliationException } from "../../../../_lib/resolve";

/** POST /api/v1/finance/reconciliation/exceptions/{id}/assign: give the exception to someone who can resolve it. */
export const POST = defineRoute({
  schemas: { params: reconciliationIdParams, body: assignExceptionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.assign", resolveReconciliationException),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await assignReconciliationException(actorOf(ctx), ctx, input.params.id, input.body)),
});
