import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { duplicateMatchersSchema, getDuplicateMatchers, setDuplicateMatchers } from "@/server/customers";

/** GET /api/v1/customers/duplicate-matchers: which matchers (phone, email, address, name) are on. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view"),
  handler: async ({ ctx }) => ok(await getDuplicateMatchers(actorOf(ctx))),
});

/** PUT /api/v1/customers/duplicate-matchers: replaces the configuration (`customers.manage`, tenant-wide). */
export const PUT = defineRoute({
  schemas: { body: duplicateMatchersSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("customers.manage"),
  handler: async ({ ctx, input }) => ok(await setDuplicateMatchers(actorOf(ctx), ctx, input.body)),
});
