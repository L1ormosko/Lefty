import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listOwnPlans, ownPlansQuerySchema } from "@/server/development";

/** GET /api/v1/me/development-plans: self-service. The caller's ACTIVE / COMPLETED / CANCELLED plans (never drafts). */
export const GET = defineRoute({
  schemas: { query: ownPlansQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnPlans(actorOf(ctx), input.query)),
});
