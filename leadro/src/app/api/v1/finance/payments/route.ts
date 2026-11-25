import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, IDEMPOTENCY_HEADER, ok, respond } from "@/server/core";
import { listPayments, listPaymentsQuerySchema, recordManualPayment, recordPaymentSchema } from "@/server/payments";
import { resolveBodyJob } from "../_lib/resolve";

/** GET /api/v1/finance/payments: payments in the caller's scope (through the job), newest first. */
export const GET = defineRoute({
  schemas: { query: listPaymentsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.view"),
  handler: async ({ ctx, input }) => respond(200, await listPayments(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/finance/payments: record a payment by hand. `Idempotency-Key` is REQUIRED (it becomes the payment's key):
 * 201 on the first request, 200 with `replayed: true` for the same key again.
 */
export const POST = defineRoute({
  schemas: { body: recordPaymentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.create", resolveBodyJob),
  idempotent: true,
  handler: async ({ req, ctx, input }) => {
    const result = await recordManualPayment(actorOf(ctx), ctx, input.body, req.headers.get(IDEMPOTENCY_HEADER));
    return result.replayed ? ok(result) : created(result);
  },
});
