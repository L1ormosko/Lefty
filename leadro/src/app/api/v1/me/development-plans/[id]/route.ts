import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOwnPlan } from "@/server/development";

/** GET /api/v1/me/development-plans/{id}: self-service. One own non-draft plan without the manager's private notes. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await getOwnPlan(actorOf(ctx), input.params.id)),
});
