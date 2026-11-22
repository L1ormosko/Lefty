import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { checkEligibilityAsActor, eligibilityCheckSchema } from "@/server/qualifications";

/**
 * POST /api/v1/qualifications/eligibility: may this employee do this job type here and then?
 * A read (nothing is stored): POST only because the requirements are a body. Needs `qualifications.view` over the employee.
 */
export const POST = defineRoute({
  schemas: { body: eligibilityCheckSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("qualifications.view", (_actor, { body }) => ({
    employeeId: body.employeeId,
  })),
  handler: async ({ ctx, input }) => ok(await checkEligibilityAsActor(actorOf(ctx), input.body)),
});
