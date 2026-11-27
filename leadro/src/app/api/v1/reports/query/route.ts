import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { runReportQuery, runReportSchema } from "@/server/reports";

/**
 * POST /api/v1/reports/query: one page of a report (a definition or a saved view). A read: POST only because the
 * definition is a JSON body. Sorted by the requested / default column, then id.
 */
export const POST = defineRoute({
  schemas: { body: runReportSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.view"),
  handler: async ({ ctx, input }) => respond(200, await runReportQuery(actorOf(ctx), input.body)),
});
