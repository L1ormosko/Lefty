import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import {
  customerIdParams,
  listEmployeePreferences,
  setEmployeePreferences,
  setEmployeePreferencesSchema,
} from "@/server/customers";
import { resolveCustomer } from "../../_lib/resolve-customer";

/** GET /api/v1/customers/{id}/employee-preferences: preferred / avoided employees (a soft dispatch factor). */
export const GET = defineRoute({
  schemas: { params: customerIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await listEmployeePreferences(actorOf(ctx), input.params.id)),
});

/** PUT /api/v1/customers/{id}/employee-preferences: replaces the whole list. */
export const PUT = defineRoute({
  schemas: { params: customerIdParams, body: setEmployeePreferencesSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await setEmployeePreferences(actorOf(ctx), ctx, input.params.id, input.body)),
});
