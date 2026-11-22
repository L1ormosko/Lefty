import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { decisionReasonSchema, rejectQualification } from "@/server/qualifications";

/** POST /api/v1/qualifications/{id}/reject: rejects a pending record (reason required). */
export const POST = defineRoute({
  schemas: { params: idParams, body: decisionReasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.approve"),
  handler: async ({ ctx, input }) => ok(await rejectQualification(actorOf(ctx), ctx, input.params.id, input.body.reason)),
});
