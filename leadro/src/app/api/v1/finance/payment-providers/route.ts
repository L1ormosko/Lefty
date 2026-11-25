import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { listPaymentProviders } from "@/server/payments";

/** GET /api/v1/finance/payment-providers: the configured payment providers (empty in this build: "not configured"). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.view"),
  handler: async ({ ctx }) => ok(await listPaymentProviders(actorOf(ctx))),
});
