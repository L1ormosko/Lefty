import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOwnMetricValue } from "@/server/performance";

/** GET /api/v1/me/metrics/{id}: self-service. One of the caller's published values with its evidence ids (else 404). */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await getOwnMetricValue(actorOf(ctx), input.params.id)),
});
