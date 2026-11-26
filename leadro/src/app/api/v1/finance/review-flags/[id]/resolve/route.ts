import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { financeIdParams, resolveReviewFlag, resolveFlagSchema } from "@/server/finance-adjustments";
import { resolveReviewFlagRef } from "../../../_lib/resolve";

/** POST /api/v1/finance/review-flags/{id}/resolve: close the flag with a resolution reason (final). */
export const POST = defineRoute({
  schemas: { params: financeIdParams, body: resolveFlagSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.edit", resolveReviewFlagRef),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await resolveReviewFlag(actorOf(ctx), ctx, input.params.id, input.body)),
});
