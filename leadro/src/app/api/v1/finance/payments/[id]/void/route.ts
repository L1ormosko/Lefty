import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { paymentIdParams, reasonSchema, voidPayment } from "@/server/payments";
import { resolvePayment } from "../../../_lib/resolve";

/** POST /api/v1/finance/payments/{id}/void: void a payment (reason required); a received one's entry is reversed. */
export const POST = defineRoute({
  schemas: { params: paymentIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.edit", resolvePayment),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await voidPayment(actorOf(ctx), ctx, input.params.id, input.body)),
});
