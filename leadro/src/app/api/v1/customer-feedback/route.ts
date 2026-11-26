import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { listCustomerFeedback, listFeedbackQuerySchema, recordCustomerFeedback, recordFeedbackSchema } from "@/server/customer-feedback";

/** GET /api/v1/customer-feedback: feedback in the caller's `customer_feedback.view` scope (the job's org unit), newest first. */
export const GET = defineRoute({
  schemas: { query: listFeedbackQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customer_feedback.view"),
  handler: async ({ ctx, input }) => respond(200, await listCustomerFeedback(actorOf(ctx), input.query)),
});

/** POST /api/v1/customer-feedback: records a customer's feedback about a job by hand (channel MANUAL). */
export const POST = defineRoute({
  schemas: { body: recordFeedbackSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customer_feedback.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await recordCustomerFeedback(actorOf(ctx), ctx, input.body)),
});
