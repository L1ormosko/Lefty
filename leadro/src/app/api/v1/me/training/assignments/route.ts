import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listOwnAssignments, ownAssignmentsQuerySchema } from "@/server/training";

/** GET /api/v1/me/training/assignments: self-service. The caller's training assignments in every status, with `overdue`. */
export const GET = defineRoute({
  schemas: { query: ownAssignmentsQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnAssignments(actorOf(ctx), input.query)),
});
