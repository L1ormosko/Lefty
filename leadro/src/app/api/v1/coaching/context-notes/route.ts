import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { createContextNote, createContextNoteSchema, listContextNotes, listContextNotesQuerySchema } from "@/server/coaching";
import { actorOf, created, defineRoute, respond } from "@/server/core";

/** GET /api/v1/coaching/context-notes: context notes the caller may read (`performance.view` with the coaching set), newest first. */
export const GET = defineRoute({
  schemas: { query: listContextNotesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => respond(200, await listContextNotes(actorOf(ctx), input.query)),
});

/** POST /api/v1/coaching/context-notes: adds context to a metric value or an employee's period (`performance.edit` + coaching set). */
export const POST = defineRoute({
  schemas: { body: createContextNoteSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.edit"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createContextNote(actorOf(ctx), ctx, input.body)),
});
