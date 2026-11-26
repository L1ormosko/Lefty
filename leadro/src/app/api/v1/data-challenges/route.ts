import "@/server/notification-targets"; // registers the resolvers the notification redaction check needs
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { listDataChallenges, listDataChallengesQuerySchema, raiseDataChallenge, raiseDataChallengeSchema } from "@/server/data-challenges";

/** GET /api/v1/data-challenges: challenges in the caller's `data_challenges.view` scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listDataChallengesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("data_challenges.view"),
  handler: async ({ ctx, input }) => respond(200, await listDataChallenges(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/data-challenges: self-service. The caller challenges one of their OWN records; no module permission is
 * needed because the service only accepts a target that belongs to the caller's employee record (else 404).
 */
export const POST = defineRoute({
  schemas: { body: raiseDataChallengeSchema },
  authenticate: authenticateRequest,
  idempotent: true,
  handler: async ({ ctx, input }) => created(await raiseDataChallenge(actorOf(ctx), ctx, input.body)),
});
