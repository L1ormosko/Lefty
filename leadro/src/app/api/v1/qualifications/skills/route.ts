import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import {
  createSkill,
  createSkillSchema,
  listSkills,
  listCatalogQuerySchema,
} from "@/server/qualifications";

/** GET /api/v1/qualifications/skills: the catalog, by name. Company-wide reference data: any `qualifications.view` grant reads it. */
export const GET = defineRoute({
  schemas: { query: listCatalogQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.view"),
  handler: async ({ ctx, input }) => respond(200, await listSkills(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications/skills: adds a catalog entry (`qualifications.manage`, tenant-wide). */
export const POST = defineRoute({
  schemas: { body: createSkillSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("qualifications.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createSkill(actorOf(ctx), ctx, input.body)),
});
