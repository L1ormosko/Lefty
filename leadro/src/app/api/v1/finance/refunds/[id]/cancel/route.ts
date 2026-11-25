import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, cancelRefund, reasonSchema } from "@/server/finance-adjustments";
import { resolveRefund } from "../../../_lib/resolve";

/** POST /api/v1/finance/refunds/{id}/cancel: withdraw a refund not yet paid out (reason required). The requester may cancel their own; others need `finance_refunds.create` (checked in the service). */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_refunds.view", resolveRefund),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await cancelRefund(actorOf(ctx), ctx, input.params.id, input.body)),
});
