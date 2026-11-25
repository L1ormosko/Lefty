import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { reconciliationIdParams, unassignExceptionSchema, unassignReconciliationException } from "@/server/reconciliation";
import { resolveReconciliationException } from "../../../../_lib/resolve";

/** POST /api/v1/finance/reconciliation/exceptions/{id}/unassign: back to the open queue. */
export const POST = defineRoute({
  schemas: { params: reconciliationIdParams, body: unassignExceptionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.assign", resolveReconciliationException),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await unassignReconciliationException(actorOf(ctx), ctx, input.params.id, input.body)),
});
