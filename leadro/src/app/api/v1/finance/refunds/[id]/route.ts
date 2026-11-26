import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, getRefund } from "@/server/finance-adjustments";
import { resolveRefund } from "../../_lib/resolve";

/** GET /api/v1/finance/refunds/{id}: one refund. */
export const GET = defineRoute({
  schemas: { params: financeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_refunds.view", resolveRefund),
  handler: async ({ ctx, input }) => ok(await getRefund(actorOf(ctx), input.params.id)),
});
