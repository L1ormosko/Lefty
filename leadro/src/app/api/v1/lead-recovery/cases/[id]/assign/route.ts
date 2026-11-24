import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { caseIdParams, assignCase, assignCaseSchema } from "@/server/recovery";
import { resolveCase } from "../../../_lib/resolvers";

/** POST /api/v1/lead-recovery/cases/{id}/assign: assigns (or with `assigneeId: null` unassigns) the recovery employee; the new owner is notified. Permission: `recovery.assign`. */
export const POST = defineRoute({
  schemas: { params: caseIdParams, body: assignCaseSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.assign", resolveCase),
  handler: async ({ ctx, input }) => ok(await assignCase(actorOf(ctx), ctx, input.params.id, input.body)),
});
