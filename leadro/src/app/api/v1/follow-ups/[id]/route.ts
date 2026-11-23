import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { followUpIdParams, getFollowUp, updateFollowUp, updateFollowUpSchema } from "@/server/follow-ups";
import { resolveFollowUp } from "../_lib/resolve-follow-up";

/** GET /api/v1/follow-ups/{id}: the task with `overdue` and the statuses it can move to (`nextStatuses`). */
export const GET = defineRoute({
  schemas: { params: followUpIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.view", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await getFollowUp(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/follow-ups/{id}: title, description, due date, priority of an open task (status and assignee have their own actions). */
export const PATCH = defineRoute({
  schemas: { params: followUpIdParams, body: updateFollowUpSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.edit", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await updateFollowUp(actorOf(ctx), ctx, input.params.id, input.body)),
});
