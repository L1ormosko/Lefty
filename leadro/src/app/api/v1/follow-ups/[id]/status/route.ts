import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { changeFollowUpStatus, changeFollowUpStatusSchema, followUpIdParams } from "@/server/follow-ups";
import { resolveFollowUp } from "../../_lib/resolve-follow-up";

/** POST /api/v1/follow-ups/{id}/status: start (IN_PROGRESS), put back or reopen (OPEN). Offline-safe (`clientEventId`, `occurredAt`). */
export const POST = defineRoute({
  schemas: { params: followUpIdParams, body: changeFollowUpStatusSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.edit", resolveFollowUp),
  handler: async ({ ctx, input }) => ok(await changeFollowUpStatus(actorOf(ctx), ctx, input.params.id, input.body)),
});
