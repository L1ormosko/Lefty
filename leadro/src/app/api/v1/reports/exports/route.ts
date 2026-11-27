import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { exportReport, listExports, listExportsQuerySchema, runReportSchema } from "@/server/reports";

/**
 * GET /api/v1/reports/exports: the export log, newest first. `audit.view` (tenant-level) sees every export; anyone
 * else with `reports.view` sees their own (checked by the service, since either permission opens it).
 */
export const GET = defineRoute({
  schemas: { query: listExportsQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listExports(actorOf(ctx), input.query)),
});

/** POST /api/v1/reports/exports: a synchronous, capped, audited CSV export of a definition or a saved view. */
export const POST = defineRoute({
  schemas: { body: runReportSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.export"),
  handler: async ({ ctx, input }) => created(await exportReport(actorOf(ctx), ctx, input.body)),
});
