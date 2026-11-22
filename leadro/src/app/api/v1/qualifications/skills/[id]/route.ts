import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { updateSkill, updateSkillSchema } from "@/server/qualifications";

/** PATCH /api/v1/qualifications/skills/{id}: edits or retires (`active: false`) an entry. Never deleted. */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateSkillSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("qualifications.manage"),
  handler: async ({ ctx, input }) => ok(await updateSkill(actorOf(ctx), ctx, input.params.id, input.body)),
});
