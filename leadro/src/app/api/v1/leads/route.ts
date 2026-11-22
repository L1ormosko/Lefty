import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok, respond } from "@/server/core";
import { createLead, createLeadSchema, listLeads, listLeadsQuerySchema } from "@/server/leads";

/** GET /api/v1/leads: paginated newest first, scope-filtered, each row projected to what its grants reveal. */
export const GET = defineRoute({
  schemas: { query: listLeadsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view"),
  handler: async ({ ctx, input }) => respond(200, await listLeads(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/leads: lead intake. The service checks `leads.create` over the service-area unit. Idempotent by the
 * `Idempotency-Key` header and by `(source, externalId)`: a repeated external id answers 200 with the existing lead.
 */
export const POST = defineRoute({
  schemas: { body: createLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await createLead(actorOf(ctx), ctx, input.body);
    return result.replayed ? ok(result.data) : created(result.data);
  },
});
