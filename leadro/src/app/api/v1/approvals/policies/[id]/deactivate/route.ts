import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { approvalIdParams, deactivatePolicy, deactivatePolicySchema } from "@/server/approvals";

/** POST /api/v1/approvals/policies/{id}/deactivate: `{ reason }`; the version stops applying to new requests (pending ones keep their snapshot). Permission: `approvals.configure` (tenant-level). */
export const POST = defineRoute({
  schemas: { params: approvalIdParams, body: deactivatePolicySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("approvals.configure"),
  handler: async ({ ctx, input }) => ok(await deactivatePolicy(actorOf(ctx), ctx, input.params.id, input.body)),
});
