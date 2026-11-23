import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listJobOutcomes, listOutcomesQuerySchema } from "@/server/job-outcomes";

/** GET /api/v1/job-outcomes: outcomes the caller may see (scope applied through the job), newest first. */
export const GET = defineRoute({
  schemas: { query: listOutcomesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.view"),
  handler: async ({ ctx, input }) => respond(200, await listJobOutcomes(actorOf(ctx), input.query)),
});
