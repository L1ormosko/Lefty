import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import {
  createCertification,
  createCertificationSchema,
  listCertifications,
  listCertificationsQuerySchema,
} from "@/server/qualifications";

/** GET /api/v1/qualifications/certifications: the catalog, by name. Company-wide reference data: any `qualifications.view` grant reads it. */
export const GET = defineRoute({
  schemas: { query: listCertificationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.view"),
  handler: async ({ ctx, input }) => respond(200, await listCertifications(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications/certifications: adds a catalog entry (`qualifications.manage`, tenant-wide). */
export const POST = defineRoute({
  schemas: { body: createCertificationSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("qualifications.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createCertification(actorOf(ctx), ctx, input.body)),
});
