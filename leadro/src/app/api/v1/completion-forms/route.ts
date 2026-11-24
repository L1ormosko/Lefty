import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createCompletionFormDraft, createCompletionFormSchema, listCompletionForms, listCompletionFormsQuerySchema } from "@/server/field-execution";

/** GET /api/v1/completion-forms: form definitions, newest first (`completion_forms.view`). */
export const GET = defineRoute({
  schemas: { query: listCompletionFormsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("completion_forms.view"),
  handler: async ({ ctx, input }) => respond(200, await listCompletionForms(actorOf(ctx), input.query)),
});

/** POST /api/v1/completion-forms: a new DRAFT version for a job type or category (tenant-wide `completion_forms.configure`). */
export const POST = defineRoute({
  schemas: { body: createCompletionFormSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("completion_forms.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createCompletionFormDraft(actorOf(ctx), ctx, input.body)),
});
