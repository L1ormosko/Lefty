import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { expiringQualificationsQuerySchema, listExpiringQualifications } from "@/server/qualifications";

/** GET /api/v1/qualifications/expiring: verified records expiring within `withinDays` (default: the company's warning days), soonest first. */
export const GET = defineRoute({
  schemas: { query: expiringQualificationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.view"),
  handler: async ({ ctx, input }) => respond(200, await listExpiringQualifications(actorOf(ctx), input.query)),
});
