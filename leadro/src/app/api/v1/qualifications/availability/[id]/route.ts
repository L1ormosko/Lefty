import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, noContent } from "@/server/core";
import { deleteAvailability } from "@/server/qualifications";

/** DELETE /api/v1/qualifications/availability/{id}: removes a window or exception (schedule data; the audit event keeps it). */
export const DELETE = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.edit"),
  handler: async ({ ctx, input }) => {
    await deleteAvailability(actorOf(ctx), ctx, input.params.id);
    return noContent();
  },
});
