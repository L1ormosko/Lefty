import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { voidCustomerFeedback, voidFeedbackSchema } from "@/server/customer-feedback";

/** POST /api/v1/customer-feedback/{id}/void: voids a mis-recorded entry once, with a reason (`customer_feedback.edit`). */
export const POST = defineRoute({
  schemas: { params: idParams, body: voidFeedbackSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customer_feedback.edit"),
  handler: async ({ ctx, input }) => ok(await voidCustomerFeedback(actorOf(ctx), ctx, input.params.id, input.body)),
});
