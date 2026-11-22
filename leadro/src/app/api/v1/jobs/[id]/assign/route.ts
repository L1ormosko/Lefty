import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { assignJob, assignJobSchema, jobIdParams } from "@/server/jobs";
import { resolveJob } from "../../_lib/resolve-job";

/** POST /api/v1/jobs/{id}/assign: give the job to one employee or one team (replaces the current assignment). */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: assignJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.assign", resolveJob),
  handler: async ({ ctx, input }) => ok(await assignJob(actorOf(ctx), ctx, input.params.id, input.body)),
});
