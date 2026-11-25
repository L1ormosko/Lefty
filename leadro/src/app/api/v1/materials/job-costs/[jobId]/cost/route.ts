import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { jobResourceRef } from "@/server/jobs";
import { costJobMaterials, costJobMaterialsSchema, jobIdParams } from "@/server/materials";

/**
 * POST /api/v1/materials/job-costs/{jobId}/cost: costs every uncosted material line of the job with the cost version in
 * effect when it was used; reports COSTED / SKIPPED (with a code) per line. Repeating it is safe.
 */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: costJobMaterialsSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", (actor, { params }: { params: { jobId: string } }, tx) => jobResourceRef(tx, actor.tenantId, params.jobId)),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await costJobMaterials(actorOf(ctx), ctx, input.params.jobId)),
});
