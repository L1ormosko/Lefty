import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, IDEMPOTENCY_HEADER, ok, respond } from "@/server/core";
import { requestRefund, requestRefundSchema, listRefunds, listRefundsQuerySchema } from "@/server/finance-adjustments";
import { resolveBodyPayment } from "../_lib/resolve";

/** GET /api/v1/finance/refunds: refunds in the caller's scope (through the job), newest first (`requestedAt desc, id desc`). */
export const GET = defineRoute({
  schemas: { query: listRefundsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_refunds.view"),
  handler: async ({ ctx, input }) => respond(200, await listRefunds(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/finance/refunds: request a (partial) refund of a RECEIVED payment; opens an approval request when a REFUND policy applies.
 * `Idempotency-Key` is REQUIRED (it becomes the record's key): 201 on the first request, 200 with `replayed: true` for the
 * same key again.
 */
export const POST = defineRoute({
  schemas: { body: requestRefundSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_refunds.create", resolveBodyPayment),
  idempotent: true,
  handler: async ({ req, ctx, input }) => {
    const result = await requestRefund(actorOf(ctx), ctx, input.body, req.headers.get(IDEMPOTENCY_HEADER));
    return result.replayed ? ok(result) : created(result);
  },
});
