import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getQualification, updateQualification, updateQualificationSchema } from "@/server/qualifications";

/** GET /api/v1/qualifications/{id}: the service checks `qualifications.view` over the holder. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.view"),
  handler: async ({ ctx, input }) => ok(await getQualification(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/qualifications/{id}: a material change to a verified record sends it back to verification. */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateQualificationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.edit"),
  handler: async ({ ctx, input }) => ok(await updateQualification(actorOf(ctx), ctx, input.params.id, input.body)),
});
