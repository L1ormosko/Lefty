import type { Prisma } from "@prisma/client";
import { formSchemaProblems } from "@/lib/completion-form-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { baseFieldMap, enforceInTx, projectFields } from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  conflictOnUniqueViolation,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { CreateCompletionFormInput, ListCompletionFormsQuery, UpdateCompletionFormInput } from "./schemas";

/**
 * Completion form definitions (§8.6): one form per job type (or per job category), VERSIONED. A version starts as a
 * DRAFT (editable), `publish` makes it the ACTIVE one and retires the previous ACTIVE version in the same transaction,
 * so there is always at most one. A published version never changes (a trigger enforces it), which is what keeps old
 * completions meaningful: each one points at the exact `(definition, version)` it was filled in with.
 *
 * Reading needs `completion_forms.view` (technicians fill the form in), writing a tenant-wide `completion_forms.configure`
 * (which makes the role require MFA). Field keys and types are the closed vocabulary of `src/lib/completion-form-rules.ts`.
 */

const FORM_COLUMNS = {
  id: true,
  jobTypeId: true,
  category: true,
  version: true,
  status: true,
  name: true,
  schema: true,
  publishedAt: true,
  publishedById: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobCompletionFormDefinitionSelect;
type FormRow = Prisma.JobCompletionFormDefinitionGetPayload<{ select: typeof FORM_COLUMNS }>;

const FORM_FIELD_MAP = baseFieldMap(Object.keys(FORM_COLUMNS));
const fullAccess = { allowed: true, fieldSets: ["base"] };
const view = (row: FormRow): Record<string, unknown> => projectFields(row, fullAccess, FORM_FIELD_MAP);

/** Turns schema problems into the 400 the client shows next to the offending field. */
function assertValidSchema(schema: unknown): void {
  const problems = formSchemaProblems(schema);
  if (problems.length === 0) return;
  throw new ValidationError({
    message: "The form definition is not valid.",
    field: "schema",
    details: problems.map((problem) => ({ field: `schema.${problem.path}`.replace(/\.$/, ""), code: `completion_form.${problem.code}`, message: `Invalid form definition (${problem.code}).` })),
  });
}

/** The ACTIVE definition for a job: its job type's own, else the one for the type's category. Null when the tenant has none. */
export async function resolveActiveFormForJob(tx: TenantTx, tenantId: string, jobId: string): Promise<FormRow | null> {
  const job = await tx.job.findFirst({ where: { id: jobId, tenantId }, select: { jobTypeId: true, jobType: { select: { category: true } } } });
  if (!job) return null;
  const byType = await tx.jobCompletionFormDefinition.findFirst({ where: { tenantId, jobTypeId: job.jobTypeId, status: "ACTIVE" }, select: FORM_COLUMNS });
  if (byType) return byType;
  return tx.jobCompletionFormDefinition.findFirst({ where: { tenantId, category: job.jobType.category, status: "ACTIVE" }, select: FORM_COLUMNS });
}

/** `GET /completion-forms`: definitions, newest version first (`completion_forms.view`). */
export async function listCompletionForms(actor: Actor, query: ListCompletionFormsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "completion_forms.view");
    const rows = await tx.jobCompletionFormDefinition.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.jobTypeId ? { jobTypeId: query.jobTypeId } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: FORM_COLUMNS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(view), page: page.page };
  });
}

export async function getCompletionForm(actor: Actor, formId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "completion_forms.view");
    const row = await tx.jobCompletionFormDefinition.findFirst({ where: { id: formId, tenantId: actor.tenantId }, select: FORM_COLUMNS });
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Creates the next DRAFT version for a job type or category (version = highest so far + 1). */
export async function createCompletionFormDraft(actor: Actor, ctx: RequestContext, input: CreateCompletionFormInput): Promise<Record<string, unknown>> {
  assertValidSchema(input.schema);
  return conflictOnUniqueViolation("Another version was created at the same time. Retry.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "completion_forms.configure", {});
      const target = input.jobTypeId ? { jobTypeId: input.jobTypeId } : { category: input.category };
      if (input.jobTypeId && !(await tx.jobType.findFirst({ where: { id: input.jobTypeId, tenantId: actor.tenantId }, select: { id: true } }))) {
        throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });
      }
      if (input.category && !(await tx.jobType.findFirst({ where: { tenantId: actor.tenantId, category: input.category }, select: { id: true } }))) {
        throw new ValidationError({ message: "No job type has this category.", field: "category", details: [{ field: "category", code: "completion_form.category_unknown", message: "No job type has this category." }] });
      }
      const latest = await tx.jobCompletionFormDefinition.aggregate({ where: { tenantId: actor.tenantId, ...target }, _max: { version: true } });
      const row = await tx.jobCompletionFormDefinition.create({
        data: {
          tenantId: actor.tenantId,
          ...target,
          version: (latest._max.version ?? 0) + 1,
          status: "DRAFT",
          name: input.name,
          schema: input.schema as Prisma.InputJsonObject,
          createdById: actor.userId,
        },
        select: FORM_COLUMNS,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "completion_form.create",
        targetType: "JobCompletionFormDefinition",
        targetId: row.id,
        newValue: { jobTypeId: row.jobTypeId, category: row.category, version: row.version, fieldKeys: input.schema.fields.map((field) => field.key) },
      });
      return view(row);
    }),
  );
}

/** Edits a DRAFT (name, schema). A published version is immutable: 409, create a new version instead. */
export async function updateCompletionFormDraft(actor: Actor, ctx: RequestContext, formId: string, input: UpdateCompletionFormInput): Promise<Record<string, unknown>> {
  if (input.schema) assertValidSchema(input.schema);
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "completion_forms.configure", {});
    const previous = await tx.jobCompletionFormDefinition.findFirst({ where: { id: formId, tenantId: actor.tenantId }, select: FORM_COLUMNS });
    if (!previous) throw new NotFoundError();
    if (previous.status !== "DRAFT") {
      throw new InvalidStateTransitionError({ message: "Only a draft can be edited. Create a new version instead.", details: [{ field: "status", code: "completion_form.not_a_draft", message: `This version is ${previous.status}.` }] });
    }
    const row = await tx.jobCompletionFormDefinition.update({
      where: { id: formId },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.schema ? { schema: input.schema as Prisma.InputJsonObject } : {}) },
      select: FORM_COLUMNS,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "completion_form.update",
      targetType: "JobCompletionFormDefinition",
      targetId: row.id,
      newValue: { version: row.version, changedFields: Object.keys(input).sort() },
    });
    return view(row);
  });
}

/** Publishes a DRAFT: it becomes the ACTIVE version and the previously active one is RETIRED, atomically. */
export async function publishCompletionForm(actor: Actor, ctx: RequestContext, formId: string): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation("Another version was published at the same time. Retry.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "completion_forms.configure", {});
      const draft = await tx.jobCompletionFormDefinition.findFirst({ where: { id: formId, tenantId: actor.tenantId }, select: FORM_COLUMNS });
      if (!draft) throw new NotFoundError();
      if (draft.status !== "DRAFT") {
        throw new ConflictError({ message: "Only a draft can be published.", details: [{ field: "status", code: "completion_form.not_a_draft", message: `This version is ${draft.status}.` }] });
      }
      assertValidSchema(draft.schema);
      const target = draft.jobTypeId ? { jobTypeId: draft.jobTypeId } : { category: draft.category };
      const retired = await tx.jobCompletionFormDefinition.updateMany({ where: { tenantId: actor.tenantId, ...target, status: "ACTIVE" }, data: { status: "RETIRED" } });
      const row = await tx.jobCompletionFormDefinition.update({
        where: { id: formId },
        data: { status: "ACTIVE", publishedAt: new Date(), publishedById: actor.userId },
        select: FORM_COLUMNS,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "completion_form.publish",
        targetType: "JobCompletionFormDefinition",
        targetId: row.id,
        newValue: { version: row.version, retiredVersions: retired.count },
      });
      return view(row);
    }),
  );
}
