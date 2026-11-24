import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { completionFormIdParams, getCompletionForm, updateCompletionFormDraft, updateCompletionFormSchema } from "@/server/field-execution";

/** GET /api/v1/completion-forms/{id}: one definition version. */
export const GET = defineRoute({
  schemas: { params: completionFormIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("completion_forms.view"),
  handler: async ({ ctx, input }) => ok(await getCompletionForm(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/completion-forms/{id}: edits a DRAFT (a published version is immutable: create a new one). */
export const PATCH = defineRoute({
  schemas: { params: completionFormIdParams, body: updateCompletionFormSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("completion_forms.configure"),
  handler: async ({ ctx, input }) => ok(await updateCompletionFormDraft(actorOf(ctx), ctx, input.params.id, input.body)),
});
