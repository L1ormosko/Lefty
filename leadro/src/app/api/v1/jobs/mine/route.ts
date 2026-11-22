import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listMyJobs, listMyJobsQuerySchema } from "@/server/jobs";

/** GET /api/v1/jobs/mine: the caller's own assigned jobs (technician view), soonest appointment first. */
export const GET = defineRoute({
  schemas: { query: listMyJobsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view"),
  handler: async ({ ctx, input }) => respond(200, await listMyJobs(actorOf(ctx), input.query)),
});
