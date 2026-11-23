import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getDispatchSettings, updateDispatchSettings, updateDispatchSettingsSchema } from "@/server/dispatch";

/** GET /api/v1/dispatch/settings: the dispatch mode and which modes can be chosen in this phase. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.view"),
  handler: async ({ ctx }) => ok(await getDispatchSettings(actorOf(ctx))),
});

/** PUT /api/v1/dispatch/settings: change the mode (tenant-wide `dispatch.manage`); RULE_BASED_AUTO / OPTIMIZATION are refused. */
export const PUT = defineRoute({
  schemas: { body: updateDispatchSettingsSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.manage"),
  handler: async ({ ctx, input }) => ok(await updateDispatchSettings(actorOf(ctx), ctx, input.body)),
});
