import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getCompletionFormForJob, jobIdParams } from "@/server/field-execution";
import { resolveJob } from "../../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/completion/form: the active form for the job's type and what the current visit already has. */
export const GET = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => ok(await getCompletionFormForJob(actorOf(ctx), input.params.id)),
});
