import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import {
  createInteraction,
  createInteractionSchema,
  leadIdParams,
  listInteractions,
  listInteractionsQuerySchema,
} from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** GET /api/v1/leads/{id}/interactions: contact attempts, notes, messages and follow-ups, newest first. */
export const GET = defineRoute({
  schemas: { params: leadIdParams, query: listInteractionsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view", resolveLead),
  handler: async ({ ctx, input }) => respond(200, await listInteractions(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/leads/{id}/interactions: record a contact attempt, note, customer message or follow-up. */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: createInteractionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit", resolveLead),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createInteraction(actorOf(ctx), ctx, input.params.id, input.body)),
});
