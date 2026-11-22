import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { jobIdParams, rescheduleJob, rescheduleJobSchema } from "@/server/jobs";
import { resolveJob } from "../../_lib/resolve-job";

/** POST /api/v1/jobs/{id}/reschedule: change the appointment window and/or the scheduled slot. */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: rescheduleJobSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit", resolveJob),
  handler: async ({ ctx, input }) => ok(await rescheduleJob(actorOf(ctx), ctx, input.params.id, input.body)),
});
