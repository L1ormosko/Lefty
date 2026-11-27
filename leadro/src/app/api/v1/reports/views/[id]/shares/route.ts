import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { shareView, shareViewSchema, viewIdParams } from "@/server/reports";

/** POST /api/v1/reports/views/{id}/shares: shares the view with a role that holds the dataset's view permission. */
export const POST = defineRoute({
  schemas: { params: viewIdParams, body: shareViewSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.manage"),
  handler: async ({ ctx, input }) => created(await shareView(actorOf(ctx), ctx, input.params.id, input.body.roleId)),
});
