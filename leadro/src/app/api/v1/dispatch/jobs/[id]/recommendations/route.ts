import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { generateRecommendation, jobIdParams, listRecommendations, listRecommendationsQuerySchema } from "@/server/dispatch";

/** GET /api/v1/dispatch/jobs/{id}/recommendations: the job's recommendations, newest first. */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listRecommendationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.view"),
  handler: async ({ ctx, input }) => respond(200, await listRecommendations(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/dispatch/jobs/{id}/recommendations: generate a recommendation (supersedes pending ones). Nothing is assigned. */
export const POST = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.create"),
  handler: async ({ ctx, input }) => created(await generateRecommendation(actorOf(ctx), ctx, input.params.id)),
});
