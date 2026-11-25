import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { confirmChargeSchema, confirmOutcomeCharge, outcomeIdParams } from "@/server/payments";
import { resolveOutcomeJob } from "../../../_lib/resolve";

/** POST /api/v1/finance/outcomes/{id}/charge: post the outcome's CHARGE (201; 200 with `replayed: true` when already posted). */
export const POST = defineRoute({
  schemas: { params: outcomeIdParams, body: confirmChargeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.create", resolveOutcomeJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await confirmOutcomeCharge(actorOf(ctx), ctx, input.params.id, input.body);
    return result.replayed ? ok(result) : created(result);
  },
});
