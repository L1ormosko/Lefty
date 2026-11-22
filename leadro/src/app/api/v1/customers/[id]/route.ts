import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { customerIdParams, getCustomer, updateCustomer, updateCustomerSchema } from "@/server/customers";
import { resolveCustomer } from "../_lib/resolve-customer";

/** GET /api/v1/customers/{id}: the customer with its active addresses. */
export const GET = defineRoute({
  schemas: { params: customerIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await getCustomer(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/customers/{id}: partial update; billing fields need the billing grant. */
export const PATCH = defineRoute({
  schemas: { params: customerIdParams, body: updateCustomerSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await updateCustomer(actorOf(ctx), ctx, input.params.id, input.body)),
});
