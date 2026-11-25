import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, IDEMPOTENCY_HEADER, ok, respond } from "@/server/core";
import { raiseManualFlag, raiseFlagSchema, listReviewFlags, listFlagsQuerySchema } from "@/server/finance-adjustments";
import { resolveBodyJob } from "../_lib/resolve";

/** GET /api/v1/finance/review-flags: finance review flags in the caller's scope (the flag's unit), newest first (`raisedAt desc, id desc`). */
export const GET = defineRoute({
  schemas: { query: listFlagsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view"),
  handler: async ({ ctx, input }) => respond(200, await listReviewFlags(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/finance/review-flags: flag a job (and optionally one of its money records) for finance review.
 * `Idempotency-Key` is REQUIRED (it becomes the record's key): 201 on the first request, 200 with `replayed: true` for the
 * same key again.
 */
export const POST = defineRoute({
  schemas: { body: raiseFlagSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.create", resolveBodyJob),
  idempotent: true,
  handler: async ({ req, ctx, input }) => {
    const result = await raiseManualFlag(actorOf(ctx), ctx, input.body, req.headers.get(IDEMPOTENCY_HEADER));
    return result.replayed ? ok(result) : created(result);
  },
});
