import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, disputeChargeback, chargebackNotesSchema } from "@/server/finance-adjustments";
import { resolveChargeback } from "../../../_lib/resolve";

/** POST /api/v1/finance/chargebacks/{id}/dispute: evidence submitted (OPEN -> DISPUTED); no money moves. */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: chargebackNotesSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_chargebacks.edit", resolveChargeback),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await disputeChargeback(actorOf(ctx), ctx, input.params.id, input.body)),
});
