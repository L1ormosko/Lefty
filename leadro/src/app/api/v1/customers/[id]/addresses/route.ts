import { z } from "zod";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { addAddress, createAddressSchema, customerIdParams, listAddresses } from "@/server/customers";
import { resolveCustomer } from "../../_lib/resolve-customer";

const listQuery = z.object({ includeArchived: z.enum(["true", "false"]).default("false") });

/** GET /api/v1/customers/{id}/addresses: active addresses, primary first (`?includeArchived=true` for all). */
export const GET = defineRoute({
  schemas: { params: customerIdParams, query: listQuery },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view", resolveCustomer),
  handler: async ({ ctx, input }) =>
    ok(await listAddresses(actorOf(ctx), input.params.id, input.query.includeArchived === "true")),
});

/** POST /api/v1/customers/{id}/addresses: adds a service address; the first one becomes the primary. */
export const POST = defineRoute({
  schemas: { params: customerIdParams, body: createAddressSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) => created(await addAddress(actorOf(ctx), ctx, input.params.id, input.body)),
});
