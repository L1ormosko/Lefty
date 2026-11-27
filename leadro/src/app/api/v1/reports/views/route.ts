import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createView, createViewSchema, listViews, listViewsQuerySchema } from "@/server/reports";

/** GET /api/v1/reports/views: own views, views shared with a role the caller holds, views they manage; newest first. */
export const GET = defineRoute({
  schemas: { query: listViewsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.view"),
  handler: async ({ ctx, input }) => respond(200, await listViews(actorOf(ctx), input.query)),
});

/** POST /api/v1/reports/views: saves a view; columns and filters are validated against the dataset and the caller's access. */
export const POST = defineRoute({
  schemas: { body: createViewSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.create"),
  handler: async ({ ctx, input }) => created(await createView(actorOf(ctx), ctx, input.body)),
});
