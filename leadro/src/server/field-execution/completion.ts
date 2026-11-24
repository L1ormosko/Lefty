import { canStillReach } from "@/lib/job-lifecycle";
import type { Prisma } from "@prisma/client";
import { formFields, formSchemaProblems, missingRequiredFields, type CompletionFacts, type CompletionFieldKey } from "@/lib/completion-form-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ConflictError, ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { recordJobEvent } from "@/server/jobs";
import { authorizeFieldRead, authorizeFieldWrite, runJobFieldWrite } from "./access";
import { resolveActiveFormForJob } from "./form-definitions";
import type { ListFieldRecordsQuery, SubmitCompletionInput } from "./schemas";

/**
 * Completion form of a visit (§8.6). The technician submits it once per `(job, visit)`; it is validated against the job
 * type's ACTIVE definition version, and the submission remembers that exact `(definition, version)`.
 *
 * The form says which facts must exist (`src/lib/completion-form-rules.ts`): the visit's outcome and its amounts, the
 * materials used, photo metadata and a signature attachment. The submission itself only carries the answers that have no
 * other home (notes, whether a follow-up is needed, the work performed). Submitting links the loose material rows to the
 * completion. It does NOT move the job: reporting the outcome already did (§9.1), and closing stays a manager's step.
 */

/** Submission is possible while the work is under way or just finished. */
const COMPLETABLE_STATUSES = ["IN_PROGRESS", "COMPLETED"];

const COMPLETION_COLUMNS = {
  id: true,
  jobId: true,
  visitNumber: true,
  employeeId: true,
  formDefinitionId: true,
  formVersion: true,
  values: true,
  workPerformed: true,
  followUpRequired: true,
  signatureAttachmentId: true,
  occurredAt: true,
  submittedAt: true,
  clientEventId: true,
} satisfies Prisma.JobCompletionSelect;

export interface SubmittedCompletion {
  completion: Record<string, unknown>;
  replayed: boolean;
}

const refusal = (field: string, code: string, message: string, retryable = false): ValidationError =>
  new ValidationError({ message, field, retryable, details: [{ field, code, message }] });

async function readCompletion(tx: TenantTx, actor: Actor, jobId: string, completionId: string): Promise<Record<string, unknown>> {
  await authorizeFieldRead(tx, actor, jobId);
  const row = await tx.jobCompletion.findFirst({ where: { id: completionId, jobId, tenantId: actor.tenantId }, select: COMPLETION_COLUMNS });
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * When the current visit began: the last time the job went EN_ROUTE (every visit starts that way), else the job's creation.
 * Photos, signatures and materials recorded before it belong to an earlier visit and must not satisfy this visit's form.
 */
async function visitStartedAt(tx: TenantTx, tenantId: string, jobId: string): Promise<Date> {
  const left = await tx.jobStatusHistory.findFirst({ where: { tenantId, jobId, toStatus: "EN_ROUTE" }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { occurredAt: true } });
  if (left) return left.occurredAt;
  return (await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId }, select: { createdAt: true } })).createdAt;
}

/** What exists for the CURRENT visit: the outcome, material rows, photo metadata and the answers being submitted. */
async function gatherFacts(tx: TenantTx, tenantId: string, jobId: string, visitNumber: number, input: SubmitCompletionInput, hasSignature: boolean): Promise<CompletionFacts> {
  const since = await visitStartedAt(tx, tenantId, jobId);
  const [outcome, materialCount, photoCount] = await Promise.all([
    tx.jobOutcome.findFirst({
      where: { tenantId, jobId, visitNumber },
      select: { outcome: true, quotedAmountMinor: true, approvedAmountMinor: true, chargedAmountMinor: true, collectedAmountMinor: true, paymentMethod: true },
    }),
    tx.jobMaterialUsage.count({ where: { tenantId, jobId, completionId: null, occurredAt: { gte: since } } }),
    // Photo METADATA counts: the device captured it; the upload may wait for storage (a FAILED one does not count).
    tx.jobAttachment.count({ where: { tenantId, jobId, kind: "PHOTO", status: { not: "FAILED" }, capturedAt: { gte: since } } }),
  ]);
  return {
    outcome: outcome ? { type: outcome.outcome, ...outcome } : null,
    materialCount,
    photoCount,
    hasSignature,
    notes: input.notes,
    followUpRequired: input.followUpRequired,
  };
}

/** Answers for fields the form does not contain are refused, so a stale client cannot store data nobody asked for. */
function assertAnswersBelongToForm(fieldKeys: readonly CompletionFieldKey[], input: SubmitCompletionInput): void {
  const answered: Array<[CompletionFieldKey, boolean, string]> = [
    ["notes", input.notes !== undefined, "notes"],
    ["followUpRequired", input.followUpRequired !== undefined, "followUpRequired"],
    ["customerSignature", input.signatureAttachmentId !== undefined, "signatureAttachmentId"],
  ];
  for (const [key, sent, field] of answered) {
    if (sent && !fieldKeys.includes(key)) throw refusal(field, "completion.field_not_in_form", "This form does not ask for that answer.");
  }
}

/** `POST /jobs/{id}/completion`: submits the completion form of the job's current visit (offline-safe through `clientEventId`). */
export async function submitCompletion(actor: Actor, ctx: RequestContext, jobId: string, input: SubmitCompletionInput): Promise<SubmittedCompletion> {
  const { result, replayed } = await runJobFieldWrite<Record<string, unknown>>(actor, {
    type: "job.completion",
    jobId,
    envelope: input,
    content: { ...input, clientEventId: undefined, deviceId: undefined, occurredAt: undefined },
    payload: { signature: input.signatureAttachmentId !== undefined },
    apply: async (tx, occurredAt) => {
      await enforceInTx(tx, actor, "completion_forms.view");
      const { job } = await authorizeFieldWrite(tx, actor, jobId);
      if (!actor.employeeId) throw new ForbiddenError({ message: "Only an employee can submit a completion form." });
      if (!COMPLETABLE_STATUSES.includes(job.status)) {
        throw new InvalidStateTransitionError({
          retryable: canStillReach(job.status, "IN_PROGRESS"), // ordering: the work-start event may not have synced yet
          message: "The completion form can be submitted while the work is in progress or just finished.",
          details: [{ field: "jobId", code: "completion.not_ready", message: `The job is ${job.status}.` }],
        });
      }
      const definition = await resolveActiveFormForJob(tx, actor.tenantId, jobId);
      if (!definition) {
        throw new ConflictError({ retryable: true, message: "No completion form is set up for this job type.", details: [{ field: "jobId", code: "completion.no_active_form", message: "Publish a form for the job type first." }] });
      }
      if (formSchemaProblems(definition.schema).length > 0) throw new ConflictError({ retryable: true, message: "The completion form of this job type is invalid.", details: [{ field: "jobId", code: "completion.form_invalid", message: "Ask an administrator to fix the form." }] });
      const fields = formFields(definition.schema);
      assertAnswersBelongToForm(fields.map((field) => field.key), input);

      const visitNumber = job.currentVisitNumber;
      if (await tx.jobCompletion.findFirst({ where: { tenantId: actor.tenantId, jobId, visitNumber }, select: { id: true } })) {
        throw new ConflictError({ message: "The completion form of this visit was already submitted.", details: [{ field: "jobId", code: "completion.already_submitted", message: "One completion form per visit." }] });
      }
      if (input.signatureAttachmentId) {
        // A signature is this visit's: captured since it began and not already used by an earlier completion.
        const signature = await tx.jobAttachment.findFirst({
          where: { id: input.signatureAttachmentId, jobId, tenantId: actor.tenantId, kind: "SIGNATURE", capturedAt: { gte: await visitStartedAt(tx, actor.tenantId, jobId) }, signedFor: { none: {} } },
          select: { id: true },
        });
        if (!signature) throw refusal("signatureAttachmentId", "completion.signature_unknown", "Choose a signature recorded for this job.", true);
      }

      const facts = await gatherFacts(tx, actor.tenantId, jobId, visitNumber, input, input.signatureAttachmentId !== undefined);
      const missing = missingRequiredFields(fields, facts);
      if (missing.length > 0) {
        throw new ValidationError({
          retryable: true, // the missing facts (outcome, photos...) may simply not have synced yet
          message: "The completion form is incomplete.",
          details: missing.map((key) => ({ field: key, code: "completion.field_required", message: `Required: ${key}.` })),
        });
      }

      // Only answers that were actually given are stored, so a field the form made optional stays "not answered".
      const values: Prisma.InputJsonObject = {
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.followUpRequired !== undefined ? { followUpRequired: input.followUpRequired } : {}),
      };
      const row = await tx.jobCompletion.create({
        data: {
          tenantId: actor.tenantId,
          jobId,
          visitNumber,
          employeeId: actor.employeeId,
          formDefinitionId: definition.id,
          formVersion: definition.version,
          values,
          workPerformed: input.workPerformed ?? null,
          followUpRequired: input.followUpRequired ?? false,
          signatureAttachmentId: input.signatureAttachmentId ?? null,
          occurredAt,
          submittedById: actor.userId,
          clientEventId: input.clientEventId ?? null,
        },
        select: COMPLETION_COLUMNS,
      });
      // The loose material rows of this visit now belong to the completion that reported them.
      await tx.jobMaterialUsage.updateMany({ where: { tenantId: actor.tenantId, jobId, completionId: null, occurredAt: { gte: await visitStartedAt(tx, actor.tenantId, jobId) } }, data: { completionId: row.id } });
      await recordJobEvent(tx, actor.tenantId, jobId, {
        type: "job.completion_submitted",
        actor,
        payload: { completionId: row.id, visitNumber, formDefinitionId: definition.id, formVersion: definition.version },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "job_completion.submit",
        targetType: "JobCompletion",
        targetId: row.id,
        newValue: { jobId, visitNumber, formDefinitionId: definition.id, formVersion: definition.version, followUpRequired: row.followUpRequired },
      });
      return { result: row, entity: { type: "JobCompletion", id: row.id } };
    },
    replay: (tx, completionId) => readCompletion(tx, actor, jobId, completionId),
  });
  return { completion: result, replayed };
}

/** `GET /jobs/{id}/completion`: the completions submitted for the job (one per visit), newest first. */
export async function listJobCompletions(actor: Actor, jobId: string, query: ListFieldRecordsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeFieldRead(tx, actor, jobId);
    const rows = await tx.jobCompletion.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: COMPLETION_COLUMNS,
      orderBy: [{ visitNumber: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/**
 * `GET /jobs/{id}/completion/form`: the form to fill in for this job (its job type's ACTIVE version) and what is
 * already in place for the current visit, so the client can show what is still missing before submitting.
 */
export async function getCompletionFormForJob(actor: Actor, jobId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "completion_forms.view");
    await authorizeFieldRead(tx, actor, jobId);
    const definition = await resolveActiveFormForJob(tx, actor.tenantId, jobId);
    if (!definition) throw new NotFoundError({ message: "No completion form is set up for this job type." });
    const job = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId: actor.tenantId }, select: { currentVisitNumber: true } });
    const existing = await tx.jobCompletion.findFirst({ where: { tenantId: actor.tenantId, jobId, visitNumber: job.currentVisitNumber }, select: { id: true } });
    const facts = await gatherFacts(tx, actor.tenantId, jobId, job.currentVisitNumber, {}, false);
    return {
      form: { id: definition.id, version: definition.version, name: definition.name, schema: definition.schema },
      visitNumber: job.currentVisitNumber,
      alreadySubmitted: existing !== null,
      // What the visit already has, as counts only (the amounts stay in the outcome, behind their own field set).
      progress: { hasOutcome: facts.outcome !== null, materialCount: facts.materialCount, photoCount: facts.photoCount },
    };
  });
}
