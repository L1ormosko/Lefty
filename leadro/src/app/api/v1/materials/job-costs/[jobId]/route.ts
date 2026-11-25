import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { jobResourceRef } from "@/server/jobs";
import { getJobMaterialCost, jobIdParams } from "@/server/materials";

/** GET /api/v1/materials/job-costs/{jobId}: the job's direct material cost (lines with their frozen snapshot, totals per currency). */
export const GET = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  // Job scope (404 outside it); the service also requires the `cost` set of materials.view (403).
  authorize: requirePermission("jobs.view", (actor, { params }: { params: { jobId: string } }, tx) => jobResourceRef(tx, actor.tenantId, params.jobId)),
  handler: async ({ ctx, input }) => ok(await getJobMaterialCost(actorOf(ctx), input.params.jobId)),
});
