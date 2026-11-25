import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getJobBalance, ledgerIdParams } from "@/server/ledger";
import { resolveFinanceJob } from "../../../_lib/resolve";

/** GET /api/v1/finance/jobs/{id}/balance: derived balances and payment status of one job, per currency. */
export const GET = defineRoute({
  schemas: { params: ledgerIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view", resolveFinanceJob),
  handler: async ({ ctx, input }) => ok(await getJobBalance(actorOf(ctx), input.params.id)),
});
