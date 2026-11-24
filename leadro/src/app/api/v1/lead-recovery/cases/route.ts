import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, respond, defineRoute } from "@/server/core";
import { listCases, listCasesQuerySchema } from "@/server/recovery";

/** GET /api/v1/lead-recovery/cases: the recovery queue in the caller's scope, newest outcome first. Presence is a status (AT_LOCATION / LEFT_LOCATION / UNKNOWN), never a position. Permission: `recovery.view`. */
export const GET = defineRoute({
  schemas: { query: listCasesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view"),
  handler: async ({ ctx, input }) => respond(200, await listCases(actorOf(ctx), input.query)),
});
