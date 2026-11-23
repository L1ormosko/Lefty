import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getLostReason, lostReasonIdParams, updateLostReason, updateLostReasonSchema } from "@/server/job-outcomes";

/** GET /api/v1/lost-reasons/{id} */
export const GET = defineRoute({
  schemas: { params: lostReasonIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.view"),
  handler: async ({ ctx, input }) => ok(await getLostReason(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/lost-reasons/{id}: edit, reorder or retire (`active: false`) a reason; the code never changes. */
export const PATCH = defineRoute({
  schemas: { params: lostReasonIdParams, body: updateLostReasonSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("job_outcomes.configure"),
  handler: async ({ ctx, input }) => ok(await updateLostReason(actorOf(ctx), ctx, input.params.id, input.body)),
});
