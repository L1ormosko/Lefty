import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { markPaymentFailed, paymentIdParams, reasonSchema } from "@/server/payments";
import { resolvePayment } from "../../../_lib/resolve";

/** POST /api/v1/finance/payments/{id}/fail: a PENDING payment did not arrive (reason required). */
export const POST = defineRoute({
  schemas: { params: paymentIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.edit", resolvePayment),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await markPaymentFailed(actorOf(ctx), ctx, input.params.id, input.body)),
});
