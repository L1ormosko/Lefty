import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { cancelFollowUp, cancelFollowUpSchema, followUpIdParams } from "@/server/follow-ups";
import { resolveFollowUp } from "../../_lib/resolve-follow-up";

/** POST /api/v1/follow-ups/{id}/cancel: cancels the task; the reason is required. Offline-safe (`clientEventId`, `occurredAt`). */
export const POST = defineRoute({
  schemas: { params: followUpIdParams, body: cancelFollowUpSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.edit", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await cancelFollowUp(actorOf(ctx), ctx, input.params.id, input.body)),
});
