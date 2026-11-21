import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOwnProfile } from "@/server/users";

/** GET /api/v1/users/me: the signed-in user's own profile (self-service, no permission needed). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  handler: async ({ ctx }) => ok(await getOwnProfile(actorOf(ctx))),
});
