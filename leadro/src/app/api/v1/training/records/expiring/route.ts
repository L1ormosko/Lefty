import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { expiringRecordsQuerySchema, listExpiringRecords } from "@/server/training";

/** GET /api/v1/training/records/expiring: verified completions expiring within `withinDays` (default: the warning days). */
export const GET = defineRoute({
  schemas: { query: expiringRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => respond(200, await listExpiringRecords(actorOf(ctx), input.query)),
});
