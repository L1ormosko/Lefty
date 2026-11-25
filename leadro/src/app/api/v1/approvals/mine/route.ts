import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listMyApprovalRequests, myApprovalsQuerySchema } from "@/server/approvals";

/** GET /api/v1/approvals/mine: the caller's own requests, newest first. Permission: `approvals.view`. */
export const GET = defineRoute({
  schemas: { query: myApprovalsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.view"),
  handler: async ({ ctx, input }) => respond(200, await listMyApprovalRequests(actorOf(ctx), input.query)),
});
