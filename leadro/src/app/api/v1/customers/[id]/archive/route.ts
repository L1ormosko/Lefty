import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveCustomer, archiveCustomerSchema, customerIdParams } from "@/server/customers";
import { resolveCustomer } from "../../_lib/resolve-customer";

/** POST /api/v1/customers/{id}/archive: soft remove (the body is optional: `{ reason? }`). */
export const POST = defineRoute({
  schemas: { params: customerIdParams, body: archiveCustomerSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.archive", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await archiveCustomer(actorOf(ctx), ctx, input.params.id, input.body)),
});
