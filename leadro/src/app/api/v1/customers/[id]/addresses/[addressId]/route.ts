import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { customerAddressParams, updateAddress, updateAddressSchema } from "@/server/customers";
import { resolveCustomer } from "../../../_lib/resolve-customer";

/** PATCH /api/v1/customers/{id}/addresses/{addressId}: partial update of one address. */
export const PATCH = defineRoute({
  schemas: { params: customerAddressParams, body: updateAddressSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) =>
    ok(await updateAddress(actorOf(ctx), ctx, input.params.id, input.params.addressId, input.body)),
});
