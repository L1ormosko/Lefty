import { defineRoute, ok } from "@/server/core";
import { intakeParams, receiveProviderEvent } from "@/server/payments";

/**
 * POST /api/v1/finance/intake/{tenantSlug}/{provider}: a payment provider's webhook. No session: the PROVIDER authenticates
 * the delivery (signature over the raw body with its per-tenant secret). With no provider configured (this build) every
 * call is 409 `payment_provider.not_configured` and nothing is written. 401 = bad signature; 200 = on record (see `status`).
 */
export const POST = defineRoute({
  schemas: { params: intakeParams },
  handler: async ({ req, input, rawBody }) =>
    ok(await receiveProviderEvent({ tenantSlug: input.params.tenantSlug, providerKey: input.params.provider, rawBody, headers: req.headers })),
});
