import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { createLeadSource, createLeadSourceSchema, listLeadSources } from "@/server/leads";

/** GET /api/v1/leads/sources: the lead sources (active and inactive), by name. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view"),
  handler: async ({ ctx }) => ok(await listLeadSources(actorOf(ctx))),
});

/** POST /api/v1/leads/sources: add a source (`leads.manage`, tenant-wide). */
export const POST = defineRoute({
  schemas: { body: createLeadSourceSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("leads.manage"),
  handler: async ({ ctx, input }) => created(await createLeadSource(actorOf(ctx), ctx, input.body)),
});
