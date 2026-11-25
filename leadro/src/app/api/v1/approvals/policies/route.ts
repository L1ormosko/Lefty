import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createPolicy, createPolicySchema, listPolicies, listPoliciesQuerySchema } from "@/server/approvals";

/** GET /api/v1/approvals/policies: approval policies (active versions by default), by subject type, currency and band. Permission: `approvals.configure` (tenant-level). */
export const GET = defineRoute({
  schemas: { query: listPoliciesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("approvals.configure"),
  handler: async ({ ctx, input }) => respond(200, await listPolicies(actorOf(ctx), input.query)),
});

/** POST /api/v1/approvals/policies: a new policy, or version + 1 of an existing `code` (the old version is deactivated). Permission: `approvals.configure` (tenant-level). */
export const POST = defineRoute({
  schemas: { body: createPolicySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("approvals.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createPolicy(actorOf(ctx), ctx, input.body)),
});
