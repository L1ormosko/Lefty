import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { reconciliationIdParams, resolveExceptionSchema, resolveReconciliationException } from "@/server/reconciliation";
import { resolveReconciliationException as resolveExceptionRef } from "../../../../_lib/resolve";

/** POST /api/v1/finance/reconciliation/exceptions/{id}/resolve: close it with a reason (the caller is the resolver). */
export const POST = defineRoute({
  schemas: { params: reconciliationIdParams, body: resolveExceptionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.edit", resolveExceptionRef),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await resolveReconciliationException(actorOf(ctx), ctx, input.params.id, input.body)),
});
