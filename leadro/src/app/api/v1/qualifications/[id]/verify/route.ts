import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { verifyQualification } from "@/server/qualifications";

/** POST /api/v1/qualifications/{id}/verify: HR confirms the record (`qualifications.approve`; not for your own). */
export const POST = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.approve"),
  handler: async ({ ctx, input }) => ok(await verifyQualification(actorOf(ctx), ctx, input.params.id)),
});
