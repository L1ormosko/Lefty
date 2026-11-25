import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listIntakeEvents, listIntakeEventsQuerySchema } from "@/server/payments";

/** GET /api/v1/finance/intake-events: the provider intake log (TENANT scope), newest first. */
export const GET = defineRoute({
  schemas: { query: listIntakeEventsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("finance_payments.view"),
  handler: async ({ ctx, input }) => respond(200, await listIntakeEvents(actorOf(ctx), input.query)),
});
