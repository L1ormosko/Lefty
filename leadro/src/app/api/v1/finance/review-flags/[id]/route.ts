import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, getReviewFlag } from "@/server/finance-adjustments";
import { resolveReviewFlagRef } from "../../_lib/resolve";

/** GET /api/v1/finance/review-flags/{id}: one flag. */
export const GET = defineRoute({
  schemas: { params: financeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view", resolveReviewFlagRef),
  handler: async ({ ctx, input }) => ok(await getReviewFlag(actorOf(ctx), input.params.id)),
});
