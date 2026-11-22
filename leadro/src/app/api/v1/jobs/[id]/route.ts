import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getJob, jobIdParams, updateJob, updateJobSchema } from "@/server/jobs";
import { resolveJob } from "../_lib/resolve-job";

/** GET /api/v1/jobs/{id}: the job with its active assignments and requirements. */
export const GET = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => ok(await getJob(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/jobs/{id}: partial update; every field sent must be writable under the caller's grant. */
export const PATCH = defineRoute({
  schemas: { params: jobIdParams, body: updateJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit", resolveJob),
  handler: async ({ ctx, input }) => ok(await updateJob(actorOf(ctx), ctx, input.params.id, input.body)),
});
