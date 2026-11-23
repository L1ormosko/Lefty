import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { assignFollowUp, assignFollowUpSchema, followUpIdParams } from "@/server/follow-ups";
import { resolveFollowUp } from "../../_lib/resolve-follow-up";

/** POST /api/v1/follow-ups/{id}/assign: assign, reassign or (`assigneeId: null`) unassign. The assignee must be in the caller's employee scope; they are notified. */
export const POST = defineRoute({
  schemas: { params: followUpIdParams, body: assignFollowUpSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.assign", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await assignFollowUp(actorOf(ctx), ctx, input.params.id, input.body)),
});
