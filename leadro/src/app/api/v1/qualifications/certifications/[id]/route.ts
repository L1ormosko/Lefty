import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { updateCertification, updateCertificationSchema } from "@/server/qualifications";

/** PATCH /api/v1/qualifications/certifications/{id}: edits or retires (`active: false`) an entry. Never deleted. */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateCertificationSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("qualifications.manage"),
  handler: async ({ ctx, input }) => ok(await updateCertification(actorOf(ctx), ctx, input.params.id, input.body)),
});
