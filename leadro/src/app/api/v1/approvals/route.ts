import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listApprovalRequests, listApprovalsQuerySchema } from "@/server/approvals";

/** GET /api/v1/approvals: every request in the caller's `approvals.manage` scope, newest first (oversight). Amounts only for holders of the approver permission. Permission: `approvals.view` + `approvals.manage`. */
export const GET = defineRoute({
  schemas: { query: listApprovalsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.manage"),
  handler: async ({ ctx, input }) => respond(200, await listApprovalRequests(actorOf(ctx), input.query)),
});
