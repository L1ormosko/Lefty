import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { getCoachingRecord, updateCoachingRecord, updateCoachingRecordSchema } from "@/server/coaching";
import { actorOf, defineRoute, ok } from "@/server/core";

/** GET /api/v1/coaching/records/{id}: the service checks `coaching.view` over the record's employee. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("coaching.view"),
  handler: async ({ ctx, input }) => ok(await getCoachingRecord(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/coaching/records/{id}: the author edits a private note (shared notes change only through a challenge). */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateCoachingRecordSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("coaching.edit"),
  handler: async ({ ctx, input }) => ok(await updateCoachingRecord(actorOf(ctx), ctx, input.params.id, input.body)),
});
