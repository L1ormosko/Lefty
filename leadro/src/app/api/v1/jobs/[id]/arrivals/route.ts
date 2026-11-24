import { jobIdParams, listJobArrivals } from "@/server/arrival";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/arrivals: the arrivals recorded for the job, newest first, with how far each is confirmed. No coordinates. */
export const GET = defineRoute({
  schemas: { params: jobIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.view", resolveJob),
  handler: async ({ ctx, input }) => ok(await listJobArrivals(actorOf(ctx), input.params.id)),
});
