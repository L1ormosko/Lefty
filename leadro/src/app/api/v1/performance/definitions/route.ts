import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createDefinition, createDefinitionSchema, listDefinitions, listDefinitionsQuerySchema } from "@/server/performance";

/**
 * GET /api/v1/performance/definitions: metric definition versions by key, newest version first. Without
 * `performance.configure` only versions that were published are listed.
 */
export const GET = defineRoute({
  schemas: { query: listDefinitionsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => respond(200, await listDefinitions(actorOf(ctx), input.query)),
});

/** POST /api/v1/performance/definitions: version 1 of a new metric key, as DRAFT. `performance.configure` at TENANT scope. */
export const POST = defineRoute({
  schemas: { body: createDefinitionSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createDefinition(actorOf(ctx), ctx, input.body)),
});
