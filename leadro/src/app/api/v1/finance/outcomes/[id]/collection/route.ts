import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { confirmCollectionSchema, confirmOutcomeCollection, outcomeIdParams } from "@/server/payments";
import { resolveOutcomeJob } from "../../../_lib/resolve";

/** POST /api/v1/finance/outcomes/{id}/collection: record the reported collection as a received payment (201; 200 on replay). */
export const POST = defineRoute({
  schemas: { params: outcomeIdParams, body: confirmCollectionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.create", resolveOutcomeJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await confirmOutcomeCollection(actorOf(ctx), ctx, input.params.id, input.body);
    return result.replayed ? ok(result) : created(result);
  },
});
