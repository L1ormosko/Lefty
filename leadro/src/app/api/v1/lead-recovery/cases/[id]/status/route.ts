import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { caseIdParams, changeCaseStatus, changeCaseStatusSchema } from "@/server/recovery";
import { resolveCase } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/cases/{id}/status: moves the case along the status machine (contacting, reached, follow-up required, not recovered, closed). Closing needs a `reason` (the final outcome). Permission: `recovery.edit`. */
export const POST = defineRoute({
  schemas: { params: caseIdParams, body: changeCaseStatusSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.edit", resolveCase),
  handler: async ({ ctx, input }) => ok(await changeCaseStatus(actorOf(ctx), ctx, input.params.id, input.body)),
});
