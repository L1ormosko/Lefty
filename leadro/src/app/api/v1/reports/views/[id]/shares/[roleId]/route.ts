import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, noContent } from "@/server/core";
import { unshareView, viewShareParams } from "@/server/reports";

/** DELETE /api/v1/reports/views/{id}/shares/{roleId}: removes the share (audited; the view itself is kept). */
export const DELETE = defineRoute({
  schemas: { params: viewShareParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.manage"),
  handler: async ({ ctx, input }) => {
    await unshareView(actorOf(ctx), ctx, input.params.id, input.params.roleId);
    return noContent();
  },
});
