import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveView, viewIdParams } from "@/server/reports";

/** POST /api/v1/reports/views/{id}/archive: the owner (`reports.create`) or a `reports.manage` holder archives a view. */
export const POST = defineRoute({
  schemas: { params: viewIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.view"),
  handler: async ({ ctx, input }) => ok(await archiveView(actorOf(ctx), ctx, input.params.id)),
});
