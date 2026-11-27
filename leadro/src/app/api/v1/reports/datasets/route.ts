import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { listDatasets } from "@/server/reports";

/** GET /api/v1/reports/datasets: the datasets the caller may report on, each with only the columns they may see. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("reports.view"),
  handler: async ({ ctx }) => ok(await listDatasets(actorOf(ctx))),
});
