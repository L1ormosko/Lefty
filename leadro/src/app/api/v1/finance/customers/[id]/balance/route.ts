import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { balanceQuerySchema, getCustomerBalance, ledgerIdParams } from "@/server/ledger";

/** GET /api/v1/finance/customers/{id}/balance: a customer's balances over the entries in the caller's scope. */
export const GET = defineRoute({
  schemas: { params: ledgerIdParams, query: balanceQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view"),
  handler: async ({ ctx, input }) => ok(await getCustomerBalance(actorOf(ctx), input.params.id, input.query)),
});
