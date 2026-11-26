import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, completeRefund, completeRefundSchema } from "@/server/finance-adjustments";
import { resolveRefund } from "../../../_lib/resolve";

/** POST /api/v1/finance/refunds/{id}/complete: the approved refund was paid out; posts its REFUND ledger entry once. */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: completeRefundSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_refunds.create", resolveRefund),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await completeRefund(actorOf(ctx), ctx, input.params.id, input.body)),
});
