import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getPayment, paymentIdParams } from "@/server/payments";
import { resolvePayment } from "../../_lib/resolve";

/** GET /api/v1/finance/payments/{id}: one payment. */
export const GET = defineRoute({
  schemas: { params: paymentIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.view", resolvePayment),
  handler: async ({ ctx, input }) => ok(await getPayment(actorOf(ctx), input.params.id)),
});
