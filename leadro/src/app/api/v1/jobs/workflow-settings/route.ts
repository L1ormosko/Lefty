import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getJobWorkflowSettings, updateJobWorkflowSettings, updateWorkflowSettingsSchema } from "@/server/jobs";

/** GET /api/v1/jobs/workflow-settings: every transition of the job lifecycle and which optional ones are switched off. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("job_types.view"),
  handler: async ({ ctx }) => ok(await getJobWorkflowSettings(actorOf(ctx))),
});

/** PUT /api/v1/jobs/workflow-settings: replace the list of optional transitions the tenant switched off. */
export const PUT = defineRoute({
  schemas: { body: updateWorkflowSettingsSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("job_types.configure"),
  handler: async ({ ctx, input }) => ok(await updateJobWorkflowSettings(actorOf(ctx), ctx, input.body)),
});
