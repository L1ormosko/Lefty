import "@/server/notification-targets"; // registers the approval subjects and notification targets this route relies on
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { approvalIdParams, decideApprovalRequest, decideApprovalSchema } from "@/server/approvals";

/** POST /api/v1/approvals/{id}/decide: `{ decision: APPROVE | REJECT, comment? }` (a rejection needs a comment). Permission: `approvals.view` plus the request's approver permission over its scope; never the requester or an editor of the subject (403). */
export const POST = defineRoute({
  schemas: { params: approvalIdParams, body: decideApprovalSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("approvals.view"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await decideApprovalRequest(actorOf(ctx), ctx, input.params.id, input.body)),
});
