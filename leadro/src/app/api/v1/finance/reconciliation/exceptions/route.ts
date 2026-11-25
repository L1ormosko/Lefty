import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listExceptionsQuerySchema, listReconciliationExceptions } from "@/server/reconciliation";

/** GET /api/v1/finance/reconciliation/exceptions: exceptions in the caller's scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listExceptionsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view"),
  handler: async ({ ctx, input }) => respond(200, await listReconciliationExceptions(actorOf(ctx), input.query)),
});
