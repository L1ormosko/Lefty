import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, unassignReviewFlag } from "@/server/finance-adjustments";
import { resolveReviewFlagRef } from "../../../_lib/resolve";

/** POST /api/v1/finance/review-flags/{id}/unassign: back to the open pool (ASSIGNED -> OPEN). */
export const POST = defineRoute({
  schemas: { params: financeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.assign", resolveReviewFlagRef),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await unassignReviewFlag(actorOf(ctx), ctx, input.params.id)),
});
