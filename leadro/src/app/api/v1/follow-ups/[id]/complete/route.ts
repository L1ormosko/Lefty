import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { completeFollowUp, completeFollowUpSchema, followUpIdParams } from "@/server/follow-ups";
import { resolveFollowUp } from "../../_lib/resolve-follow-up";

/** POST /api/v1/follow-ups/{id}/complete: marks the task DONE with an optional note. Offline-safe (`clientEventId`, `occurredAt`). */
export const POST = defineRoute({
  schemas: { params: followUpIdParams, body: completeFollowUpSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.edit", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await completeFollowUp(actorOf(ctx), ctx, input.params.id, input.body)),
});
