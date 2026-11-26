import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { shareContextNote } from "@/server/coaching";
import { actorOf, defineRoute, ok } from "@/server/core";

/** POST /api/v1/coaching/context-notes/{id}/share: shares the note with its employee (one way). */
export const POST = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.edit"),
  handler: async ({ ctx, input }) => ok(await shareContextNote(actorOf(ctx), ctx, input.params.id)),
});
