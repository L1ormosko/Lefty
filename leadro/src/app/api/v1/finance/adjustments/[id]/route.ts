import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, getAdjustment } from "@/server/finance-adjustments";
import { resolveAdjustment } from "../../_lib/resolve";

/** GET /api/v1/finance/adjustments/{id}: one adjustment. */
export const GET = defineRoute({
  schemas: { params: financeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_adjustments.view", resolveAdjustment),
  handler: async ({ ctx, input }) => ok(await getAdjustment(actorOf(ctx), input.params.id)),
});
