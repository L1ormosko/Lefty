import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { caseIdParams, recordAttempt, recordAttemptSchema } from "@/server/recovery";
import { resolveCase } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/cases/{id}/attempts: records one communication attempt; the first one moves a NEW / ASSIGNED case to CONTACTING. Permission: `recovery.edit`. */
export const POST = defineRoute({
  schemas: { params: caseIdParams, body: recordAttemptSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.edit", resolveCase),
  handler: async ({ ctx, input }) => created(await recordAttempt(actorOf(ctx), ctx, input.params.id, input.body)),
});
