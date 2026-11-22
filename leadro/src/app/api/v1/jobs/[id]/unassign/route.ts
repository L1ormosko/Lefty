import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { jobIdParams, unassignJob, unassignJobSchema } from "@/server/jobs";
import { resolveJob } from "../../_lib/resolve-job";

/** POST /api/v1/jobs/{id}/unassign: take the job off its assignee; it returns to PENDING_ASSIGNMENT. */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: unassignJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.assign", resolveJob),
  handler: async ({ ctx, input }) => ok(await unassignJob(actorOf(ctx), ctx, input.params.id, input.body)),
});
