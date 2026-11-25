import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { markPaymentReceived, markReceivedSchema, paymentIdParams } from "@/server/payments";
import { resolvePayment } from "../../../_lib/resolve";

/** POST /api/v1/finance/payments/{id}/receive: a PENDING payment arrived; posts its PAYMENT entry. */
export const POST = defineRoute({
  schemas: { params: paymentIdParams, body: markReceivedSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.edit", resolvePayment),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await markPaymentReceived(actorOf(ctx), ctx, input.params.id, input.body)),
});
