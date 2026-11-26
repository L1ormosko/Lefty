import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getDataChallenge } from "@/server/data-challenges";

/** GET /api/v1/data-challenges/{id}: the service checks `data_challenges.view` over the challenged employee. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("data_challenges.view"),
  handler: async ({ ctx, input }) => ok(await getDataChallenge(actorOf(ctx), input.params.id)),
});
