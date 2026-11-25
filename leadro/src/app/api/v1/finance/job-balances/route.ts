import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { jobBalancesQuerySchema, listJobBalances } from "@/server/ledger";

/** GET /api/v1/finance/job-balances: jobs with ledger entries in the caller's scope, newest job first, with balances. */
export const GET = defineRoute({
  schemas: { query: jobBalancesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view"),
  handler: async ({ ctx, input }) => respond(200, await listJobBalances(actorOf(ctx), input.query)),
});
