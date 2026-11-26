import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, getChargeback } from "@/server/finance-adjustments";
import { resolveChargeback } from "../../_lib/resolve";

/** GET /api/v1/finance/chargebacks/{id}: one chargeback. */
export const GET = defineRoute({
  schemas: { params: financeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_chargebacks.view", resolveChargeback),
  handler: async ({ ctx, input }) => ok(await getChargeback(actorOf(ctx), input.params.id)),
});
