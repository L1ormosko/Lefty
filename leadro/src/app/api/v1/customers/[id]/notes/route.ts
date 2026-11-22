import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { addNote, createNoteSchema, customerIdParams, listNotes, listNotesQuerySchema } from "@/server/customers";
import { resolveCustomer } from "../../_lib/resolve-customer";

/** GET /api/v1/customers/{id}/notes: newest first. */
export const GET = defineRoute({
  schemas: { params: customerIdParams, query: listNotesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view", resolveCustomer),
  handler: async ({ ctx, input }) => respond(200, await listNotes(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/customers/{id}/notes: appends a note authored by the caller (notes are not edited). */
export const POST = defineRoute({
  schemas: { params: customerIdParams, body: createNoteSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit", resolveCustomer),
  handler: async ({ ctx, input }) => created(await addNote(actorOf(ctx), ctx, input.params.id, input.body)),
});
