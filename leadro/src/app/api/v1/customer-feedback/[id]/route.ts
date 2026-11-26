import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getCustomerFeedback } from "@/server/customer-feedback";

/** GET /api/v1/customer-feedback/{id}: the service checks `customer_feedback.view` over the job's org unit (404 outside). */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("customer_feedback.view"),
  handler: async ({ ctx, input }) => ok(await getCustomerFeedback(actorOf(ctx), input.params.id)),
});
