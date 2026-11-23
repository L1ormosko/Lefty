import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getEligibilityOverview, jobIdParams } from "@/server/dispatch";

/** GET /api/v1/dispatch/jobs/{id}/candidates: who passes the hard eligibility rules now, and why the others do not. */
export const GET = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.view"),
  handler: async ({ ctx, input }) => ok(await getEligibilityOverview(actorOf(ctx), input.params.id)),
});
