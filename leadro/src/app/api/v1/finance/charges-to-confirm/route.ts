import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { chargesToConfirmQuerySchema, listChargesToConfirm } from "@/server/payments";

/** GET /api/v1/finance/charges-to-confirm: SOLD outcomes whose charge or collection finance has not posted yet, oldest first. */
export const GET = defineRoute({
  schemas: { query: chargesToConfirmQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.view"),
  handler: async ({ ctx, input }) => respond(200, await listChargesToConfirm(actorOf(ctx), input.query)),
});
