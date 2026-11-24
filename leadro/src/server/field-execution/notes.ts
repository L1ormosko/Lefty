import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { JOB_FIELD_NOTE_FIELD_MAP, projectFields } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { recordJobEvent } from "@/server/jobs";
import { assertWorkedByCaller, authorizeFieldRead, authorizeFieldWrite, runJobFieldWrite } from "./access";
import { holdsOutcomeFinancialSet } from "@/server/job-outcomes";
import type { ListFieldRecordsQuery, RecordFieldNoteInput } from "./schemas";

/**
 * Field notes (§8.5): what the technician wrote or the customer said during the visit. One table, four kinds:
 * a plain note, the work performed, ADDITIONAL work the customer requested (with an optional estimate) and the
 * customer's approval or refusal of it. Free text stays in `JobFieldNote.body`; events, audit and the offline log
 * carry ids and kinds only. Amounts are minor units in the job's currency and need the financial field set.
 */

const NOTE_COLUMNS = {
  id: true,
  jobId: true,
  employeeId: true,
  kind: true,
  body: true,
  amountMinor: true,
  currency: true,
  customerApproved: true,
  occurredAt: true,
  recordedAt: true,
  clientEventId: true,
} satisfies Prisma.JobFieldNoteSelect;
type NoteRow = Prisma.JobFieldNoteGetPayload<{ select: typeof NOTE_COLUMNS }>;

/** The amount and currency show only to callers who hold the financial set (§22.2 least privilege). */
function viewNote(row: NoteRow, mayHandleMoney: boolean): Record<string, unknown> {
  return projectFields(row, { allowed: true, fieldSets: mayHandleMoney ? ["base", "financial"] : ["base"] }, JOB_FIELD_NOTE_FIELD_MAP);
}

export interface RecordedFieldNote {
  note: Record<string, unknown>;
  /** True when a repeated `clientEventId` was answered from the first delivery. */
  replayed: boolean;
}

async function readNote(tx: TenantTx, actor: Actor, jobId: string, noteId: string): Promise<Record<string, unknown>> {
  const ref = await authorizeFieldRead(tx, actor, jobId);
  const row = await tx.jobFieldNote.findFirst({ where: { id: noteId, jobId, tenantId: actor.tenantId }, select: NOTE_COLUMNS });
  if (!row) throw new NotFoundError();
  return viewNote(row, await holdsOutcomeFinancialSet(tx, actor, ref));
}

/** `POST /jobs/{id}/notes`: records a note of the visit (offline-safe through `clientEventId`). */
export async function recordFieldNote(actor: Actor, ctx: RequestContext, jobId: string, input: RecordFieldNoteInput): Promise<RecordedFieldNote> {
  const { result, replayed } = await runJobFieldWrite<Record<string, unknown>>(actor, {
    type: "job.note",
    jobId,
    envelope: input,
    content: { ...input, clientEventId: undefined, deviceId: undefined, occurredAt: undefined },
    payload: { kind: input.kind },
    apply: async (tx, occurredAt) => {
      const { job, currency, mayHandleMoney, ref } = await authorizeFieldWrite(tx, actor, jobId);
      if (input.kind === "CUSTOMER_APPROVAL") assertWorkedByCaller(ref, actor, "the customer's approval");
      if (input.amountMinor !== undefined && !mayHandleMoney) {
        throw new ForbiddenError({ message: "Your access does not include amounts.", field: "amountMinor" });
      }
      if (input.currency !== undefined && input.currency !== currency) {
        throw new ValidationError({ message: "The amount must be in the job's currency.", field: "currency", details: [{ field: "currency", code: "job_note.currency_mismatch", message: "The amount must be in the job's currency." }] });
      }
      const row = await tx.jobFieldNote.create({
        data: {
          tenantId: actor.tenantId,
          jobId,
          employeeId: actor.employeeId ?? null,
          kind: input.kind,
          body: input.body,
          amountMinor: input.amountMinor ?? null,
          currency,
          customerApproved: input.customerApproved ?? null,
          occurredAt,
          clientEventId: input.clientEventId ?? null,
        },
        select: NOTE_COLUMNS,
      });
      await recordJobEvent(tx, actor.tenantId, jobId, { type: `job.field_note.${row.kind.toLowerCase()}`, actor, payload: { noteId: row.id, kind: row.kind, visitNumber: job.currentVisitNumber } });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "job_note.record",
        targetType: "JobFieldNote",
        targetId: row.id,
        // Free text and money stay out of the trail: it records that and what kind of note was written.
        newValue: { jobId, kind: row.kind, hasAmount: row.amountMinor !== null, customerApproved: row.customerApproved },
      });
      return { result: viewNote(row, mayHandleMoney), entity: { type: "JobFieldNote", id: row.id } };
    },
    replay: (tx, noteId) => readNote(tx, actor, jobId, noteId),
  });
  return { note: result, replayed };
}

/** `GET /jobs/{id}/notes`: the job's notes, newest first. */
export async function listFieldNotes(actor: Actor, jobId: string, query: ListFieldRecordsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    const ref = await authorizeFieldRead(tx, actor, jobId);
    const mayHandleMoney = await holdsOutcomeFinancialSet(tx, actor, ref);
    const rows = await tx.jobFieldNote.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: NOTE_COLUMNS,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => viewNote(row, mayHandleMoney)), page: page.page };
  });
}
