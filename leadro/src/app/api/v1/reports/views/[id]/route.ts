import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getView, updateView, updateViewSchema, viewIdParams } from "@/server/reports";

/** GET /api/v1/reports/views/{id}: a view the caller owns, manages or holds a shared role of (else 404). */
export const GET = defineRoute({
  schemas: { params: viewIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.view"),
  handler: async ({ ctx, input }) => ok(await getView(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/reports/views/{id}: the owner changes name, columns, filters or org unit of an active view. */
export const PATCH = defineRoute({
  schemas: { params: viewIdParams, body: updateViewSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.create"),
  handler: async ({ ctx, input }) => ok(await updateView(actorOf(ctx), ctx, input.params.id, input.body)),
});
