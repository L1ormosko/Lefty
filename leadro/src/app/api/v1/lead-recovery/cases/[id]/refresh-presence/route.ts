import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { caseIdParams, refreshPresence } from "@/server/recovery";
import { resolveCase } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/cases/{id}/refresh-presence: re-evaluates the technician's presence from the latest valid location (status only; UNKNOWN when there is none). Permission: `recovery.edit`. */
export const POST = defineRoute({
  schemas: { params: caseIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.edit", resolveCase),
  handler: async ({ ctx, input }) => ok(await refreshPresence(actorOf(ctx), ctx, input.params.id)),
});
