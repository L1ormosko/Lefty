import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { archiveCoachingRecord } from "@/server/coaching";
import { actorOf, defineRoute, ok } from "@/server/core";

/** POST /api/v1/coaching/records/{id}/archive: archives the note (never deleted). */
export const POST = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("coaching.edit"),
  handler: async ({ ctx, input }) => ok(await archiveCoachingRecord(actorOf(ctx), ctx, input.params.id)),
});
