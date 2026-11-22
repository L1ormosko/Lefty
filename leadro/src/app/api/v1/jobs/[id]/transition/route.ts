import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { jobIdParams, transitionJob, transitionJobSchema } from "@/server/jobs";
import { resolveJob } from "../../_lib/resolve-job";

/** POST /api/v1/jobs/{id}/transition: move the job to another status along the lifecycle machine. */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: transitionJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit", resolveJob),
  handler: async ({ ctx, input }) => ok(await transitionJob(actorOf(ctx), ctx, input.params.id, input.body)),
});
