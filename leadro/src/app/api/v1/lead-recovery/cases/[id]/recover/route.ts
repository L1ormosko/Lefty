import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { caseIdParams, recoverCase, recoverCaseSchema } from "@/server/recovery";
import { resolveCase } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/cases/{id}/recover: confirms the recovery with CONFIRMED amounts and links the recovered job / lead of the same customer. The estimate stays separate. Permission: `recovery.edit`. */
export const POST = defineRoute({
  schemas: { params: caseIdParams, body: recoverCaseSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.edit", resolveCase),
  handler: async ({ ctx, input }) => ok(await recoverCase(actorOf(ctx), ctx, input.params.id, input.body)),
});
