import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { listRecords, listRecordsQuerySchema, recordCompletion, recordCompletionSchema } from "@/server/training";

/** GET /api/v1/training/records: completion records in the caller's scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => respond(200, await listRecords(actorOf(ctx), input.query)),
});

/** POST /api/v1/training/records: records a completion with evidence metadata (`training.create`); it awaits verification. */
export const POST = defineRoute({
  schemas: { body: recordCompletionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await recordCompletion(actorOf(ctx), ctx, input.body)),
});
