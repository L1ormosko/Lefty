import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createCustomer, createCustomerSchema, listCustomers, listCustomersQuerySchema } from "@/server/customers";

/** GET /api/v1/customers: paginated by name, scope-filtered, each row projected to what its grants reveal. */
export const GET = defineRoute({
  schemas: { query: listCustomersQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view"),
  handler: async ({ ctx, input }) => respond(200, await listCustomers(actorOf(ctx), input.query)),
});

/** POST /api/v1/customers: the service checks `customers.create` over the service-area unit; flags possible duplicates. */
export const POST = defineRoute({
  schemas: { body: createCustomerSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createCustomer(actorOf(ctx), ctx, input.body)),
});
