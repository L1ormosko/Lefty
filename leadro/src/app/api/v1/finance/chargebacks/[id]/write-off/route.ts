import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, requestChargebackWriteOff, reasonSchema } from "@/server/finance-adjustments";
import { resolveChargeback } from "../../../_lib/resolve";

/** POST /api/v1/finance/chargebacks/{id}/write-off: write a LOST chargeback off (approval when a CHARGEBACK_WRITE_OFF policy applies). */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_chargebacks.edit", resolveChargeback),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await requestChargebackWriteOff(actorOf(ctx), ctx, input.params.id, input.body)),
});
