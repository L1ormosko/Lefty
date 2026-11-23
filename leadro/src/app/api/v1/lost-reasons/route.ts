import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { createLostReason, createLostReasonSchema, listLostReasons, listLostReasonsQuerySchema } from "@/server/job-outcomes";

/** GET /api/v1/lost-reasons: the tenant's lost reasons in display order (active only unless `includeInactive=true`). */
export const GET = defineRoute({
  schemas: { query: listLostReasonsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.view"),
  handler: async ({ ctx, input }) => ok(await listLostReasons(actorOf(ctx), input.query)),
});

/** POST /api/v1/lost-reasons: add a lost reason (tenant-wide `job_outcomes.configure`). */
export const POST = defineRoute({
  schemas: { body: createLostReasonSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("job_outcomes.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createLostReason(actorOf(ctx), ctx, input.body)),
});
