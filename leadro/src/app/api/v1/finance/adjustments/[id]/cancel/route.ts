import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, cancelAdjustment, reasonSchema } from "@/server/finance-adjustments";
import { resolveAdjustment } from "../../../_lib/resolve";

/** POST /api/v1/finance/adjustments/{id}/cancel: withdraw a pending adjustment (reason required). The requester, or `finance_adjustments.create` (checked in the service). */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_adjustments.view", resolveAdjustment),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await cancelAdjustment(actorOf(ctx), ctx, input.params.id, input.body)),
});
