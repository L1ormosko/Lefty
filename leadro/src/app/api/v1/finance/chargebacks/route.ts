import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, IDEMPOTENCY_HEADER, ok, respond } from "@/server/core";
import { recordChargeback, recordChargebackSchema, listChargebacks, listChargebacksQuerySchema } from "@/server/finance-adjustments";
import { resolveBodyPayment } from "../_lib/resolve";

/** GET /api/v1/finance/chargebacks: chargebacks in the caller's scope (through the job), newest first (`openedAt desc, id desc`). */
export const GET = defineRoute({
  schemas: { query: listChargebacksQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_chargebacks.view"),
  handler: async ({ ctx, input }) => respond(200, await listChargebacks(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/finance/chargebacks: record a chargeback by hand against a RECEIVED payment; posts its CHARGEBACK entry.
 * `Idempotency-Key` is REQUIRED (it becomes the record's key): 201 on the first request, 200 with `replayed: true` for the
 * same key again.
 */
export const POST = defineRoute({
  schemas: { body: recordChargebackSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_chargebacks.create", resolveBodyPayment),
  idempotent: true,
  handler: async ({ req, ctx, input }) => {
    const result = await recordChargeback(actorOf(ctx), ctx, input.body, req.headers.get(IDEMPOTENCY_HEADER));
    return result.replayed ? ok(result) : created(result);
  },
});
