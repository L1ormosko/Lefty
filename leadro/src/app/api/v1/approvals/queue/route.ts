import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { approvalQueueQuerySchema, listApprovalQueue } from "@/server/approvals";

/** GET /api/v1/approvals/queue: pending, unexpired requests the caller can decide now (approver permission over the scope, not the requester or an editor, not yet decided), oldest first. Permission: `approvals.view`. */
export const GET = defineRoute({
  schemas: { query: approvalQueueQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.view"),
  handler: async ({ ctx, input }) => respond(200, await listApprovalQueue(actorOf(ctx), input.query)),
});
