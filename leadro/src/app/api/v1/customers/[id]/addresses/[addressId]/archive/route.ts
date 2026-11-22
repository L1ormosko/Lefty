import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveAddress, customerAddressParams } from "@/server/customers";
import { resolveCustomer } from "../../../../_lib/resolve-customer";

/** POST /api/v1/customers/{id}/addresses/{addressId}/archive: soft remove; another address becomes primary when needed. */
export const POST = defineRoute({
  schemas: { params: customerAddressParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) => ok(await archiveAddress(actorOf(ctx), ctx, input.params.id, input.params.addressId)),
});
