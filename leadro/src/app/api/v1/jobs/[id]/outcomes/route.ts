import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { jobIdParams, listJobOutcomes, listOutcomesQuerySchema } from "@/server/job-outcomes";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/outcomes: the outcomes recorded for this job, one per visit, newest first. */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listOutcomesQuerySchema.omit({ jobId: true }) },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.view", resolveJob),
  handler: async ({ ctx, input }) => respond(200, await listJobOutcomes(actorOf(ctx), { ...input.query, jobId: input.params.id })),
});
