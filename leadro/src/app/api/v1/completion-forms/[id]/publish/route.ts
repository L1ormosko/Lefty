import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { completionFormIdParams, publishCompletionForm } from "@/server/field-execution";

/** POST /api/v1/completion-forms/{id}/publish: makes a DRAFT the active version and retires the previous one. */
export const POST = defineRoute({
  schemas: { params: completionFormIdParams },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("completion_forms.configure"),
  handler: async ({ ctx, input }) => ok(await publishCompletionForm(actorOf(ctx), ctx, input.params.id)),
});
