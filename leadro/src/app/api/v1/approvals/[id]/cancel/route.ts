import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { approvalIdParams, cancelApprovalRequest, cancelApprovalSchema } from "@/server/approvals";

/** POST /api/v1/approvals/{id}/cancel: `{ reason }`; withdraws a pending request. Permission: `approvals.view`, and the caller is the requester or holds `approvals.manage` over the request. */
export const POST = defineRoute({
  schemas: { params: approvalIdParams, body: cancelApprovalSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.view"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await cancelApprovalRequest(actorOf(ctx), ctx, input.params.id, input.body)),
});
