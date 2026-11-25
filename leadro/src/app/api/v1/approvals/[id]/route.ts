import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { approvalIdParams, getApprovalRequest } from "@/server/approvals";

/** GET /api/v1/approvals/{id}: one request with its decisions, if the caller is its requester, an eligible approver or an approvals manager over it (else 404). Permission: `approvals.view`. */
export const GET = defineRoute({
  schemas: { params: approvalIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.view"),
  handler: async ({ ctx, input }) => ok(await getApprovalRequest(actorOf(ctx), input.params.id)),
});
