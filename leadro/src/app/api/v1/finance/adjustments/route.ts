import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, IDEMPOTENCY_HEADER, ok, respond } from "@/server/core";
import { requestAdjustment, requestAdjustmentSchema, listAdjustments, listAdjustmentsQuerySchema } from "@/server/finance-adjustments";
import { resolveBodyJob } from "../_lib/resolve";

/** GET /api/v1/finance/adjustments: adjustments in the caller's scope (through the job), newest first (`requestedAt desc, id desc`). */
export const GET = defineRoute({
  schemas: { query: listAdjustmentsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_adjustments.view"),
  handler: async ({ ctx, input }) => respond(200, await listAdjustments(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/finance/adjustments: request a credit (negative) or debit (positive) on a job with a reason; posted at once or after approval.
 * `Idempotency-Key` is REQUIRED (it becomes the record's key): 201 on the first request, 200 with `replayed: true` for the
 * same key again.
 */
export const POST = defineRoute({
  schemas: { body: requestAdjustmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_adjustments.create", resolveBodyJob),
  idempotent: true,
  handler: async ({ req, ctx, input }) => {
    const result = await requestAdjustment(actorOf(ctx), ctx, input.body, req.headers.get(IDEMPOTENCY_HEADER));
    return result.replayed ? ok(result) : created(result);
  },
});
