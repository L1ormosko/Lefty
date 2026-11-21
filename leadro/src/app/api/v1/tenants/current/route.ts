import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getTenantProfile, updateTenantProfile, updateTenantProfileSchema } from "@/server/organization";

/** GET /api/v1/tenants/current: the caller's company profile. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("company_settings.view"),
  handler: async ({ ctx }) => ok(await getTenantProfile(actorOf(ctx))),
});

/** PATCH /api/v1/tenants/current: edit name and locale / time-zone defaults. */
export const PATCH = defineRoute({
  schemas: { body: updateTenantProfileSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("company_settings.edit"),
  handler: async ({ ctx, input }) => ok(await updateTenantProfile(actorOf(ctx), ctx, input.body)),
});
