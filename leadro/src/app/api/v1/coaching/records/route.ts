import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { createCoachingRecord, createCoachingRecordSchema, listCoachingRecords, listCoachingRecordsQuerySchema } from "@/server/coaching";
import { actorOf, created, defineRoute, respond } from "@/server/core";

/** GET /api/v1/coaching/records: coaching notes in the caller's `coaching.view` scope, newest conversation first. */
export const GET = defineRoute({
  schemas: { query: listCoachingRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("coaching.view"),
  handler: async ({ ctx, input }) => respond(200, await listCoachingRecords(actorOf(ctx), input.query)),
});

/** POST /api/v1/coaching/records: writes a coaching note about an employee (private unless `shareWithEmployee`). */
export const POST = defineRoute({
  schemas: { body: createCoachingRecordSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("coaching.create", (_actor, { body }) => ({ employeeId: body.employeeId })),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createCoachingRecord(actorOf(ctx), ctx, input.body)),
});
