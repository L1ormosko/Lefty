import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { jobIdParams, listHistoryQuerySchema, listJobAssignments } from "@/server/jobs";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/assignments: every assignment the job has had (active first). */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listHistoryQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => respond(200, await listJobAssignments(actorOf(ctx), input.params.id, input.query)),
});
