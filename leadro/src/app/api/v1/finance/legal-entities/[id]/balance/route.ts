import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { balanceQuerySchema, getLegalEntityBalance, ledgerIdParams } from "@/server/ledger";

/** GET /api/v1/finance/legal-entities/{id}/balance: balances of one legal entity (TENANT or that LEGAL_ENTITY scope). */
export const GET = defineRoute({
  schemas: { params: ledgerIdParams, query: balanceQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view", (_actor, { params }) => ({ legalEntityId: params.id })),
  handler: async ({ ctx, input }) => ok(await getLegalEntityBalance(actorOf(ctx), input.params.id, input.query)),
});
