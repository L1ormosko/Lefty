import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { customerIdParams, getCustomerHistory, historyQuerySchema } from "@/server/customers";
import { resolveCustomer } from "../../_lib/resolve-customer";

/** GET /api/v1/customers/{id}/history: the customer's leads and jobs (ids, numbers, statuses) the caller may view. */
export const GET = defineRoute({
  schemas: { params: customerIdParams, query: historyQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await getCustomerHistory(actorOf(ctx), input.params.id, input.query)),
});
