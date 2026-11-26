import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getDevelopmentThresholds, updateDevelopmentThresholds, updateDevelopmentThresholdsSchema } from "@/server/development";

/** GET /api/v1/training/recommendations/thresholds: the tenant's development thresholds (empty = rule disabled). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx }) => ok(await getDevelopmentThresholds(actorOf(ctx))),
});

/** PUT /api/v1/training/recommendations/thresholds: replaces the list (`[]` disables the rule); TENANT-wide `training.manage`. */
export const PUT = defineRoute({
  schemas: { body: updateDevelopmentThresholdsSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.manage"),
  handler: async ({ ctx, input }) => ok(await updateDevelopmentThresholds(actorOf(ctx), ctx, input.body)),
});
