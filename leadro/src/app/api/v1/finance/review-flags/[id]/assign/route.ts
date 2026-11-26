import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, assignReviewFlag, assignFlagSchema } from "@/server/finance-adjustments";
import { resolveReviewFlagRef } from "../../../_lib/resolve";

/** POST /api/v1/finance/review-flags/{id}/assign: give the flag to someone who can see it (OPEN or ASSIGNED -> ASSIGNED). */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: assignFlagSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.assign", resolveReviewFlagRef),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await assignReviewFlag(actorOf(ctx), ctx, input.params.id, input.body)),
});
