import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, ok, defineRoute } from "@/server/core";
import { caseIdParams, getCase, updateCase, updateCaseSchema } from "@/server/recovery";
import { resolveCase } from "../../_lib/resolvers";

/** GET /api/v1/lead-recovery/cases/{id}: the case with attempts, status history and follow-up tasks. Permission: `recovery.view`. */
export const GET = defineRoute({
  schemas: { params: caseIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.view", resolveCase),
  handler: async ({ ctx, input }) => ok(await getCase(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/lead-recovery/cases/{id}: the employee's estimate and the priority of an open case. Permission: `recovery.edit`. */
export const PATCH = defineRoute({
  schemas: { params: caseIdParams, body: updateCaseSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("recovery.edit", resolveCase),
  handler: async ({ ctx, input }) => ok(await updateCase(actorOf(ctx), ctx, input.params.id, input.body)),
});
