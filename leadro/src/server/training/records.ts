import type { Prisma } from "@prisma/client";
import { addDays, localIsoDate } from "@/lib/zoned-time";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, ValidationError, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { enforceOverEmployee, loadActiveEmployee, tenantCalendar } from "./access";
import type { ListRecordsQuery, RecordCompletionInput } from "./schemas";
import { dateColumn, recordScopeColumns, toRecordView, type RecordView } from "./views";

/**
 * Training records (§10.1, §5.8): a completed course, recorded with evidence METADATA (no StorageProvider is configured,
 * so `evidenceStorageKey` stays null, §28.3) and then verified, rejected or revoked by HR (`verification.ts`). Only a
 * VERIFIED record counts: it completes the open assignment and may grant a TRAINING qualification.
 *
 * Expiry: `expiresAt` = the completion's tenant-local date + the course's `validityDays` at the time of recording (null =
 * does not expire). A later change of the course's validity does not move existing records.
 */

/** Clock skew tolerated between the client that reports a completion and the server. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** `POST /training/records`: records a completion (`training.create` over the employee); it waits for HR's verification. */
export async function recordCompletion(actor: Actor, ctx: RequestContext, input: RecordCompletionInput): Promise<RecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceOverEmployee(tx, actor, "training.create", input.employeeId);
    await loadActiveEmployee(tx, actor.tenantId, input.employeeId);
    if (input.completedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new ValidationError({ message: "The completion cannot be in the future.", field: "completedAt" });
    }
    // An archived course can still receive completions: the training may have happened before it was archived.
    const course = await tx.trainingCourse.findFirst({ where: { id: input.courseId, tenantId: actor.tenantId }, select: { validityDays: true } });
    if (!course) throw new ValidationError({ message: "Unknown course.", field: "courseId" });
    const { timeZone } = await tenantCalendar(tx, actor.tenantId);
    const completedOn = localIsoDate(input.completedAt.getTime(), timeZone);
    const expiresOn = course.validityDays ? addDays(completedOn, course.validityDays) : null;

    const evidence = input.evidence ?? {};
    const row = await tx.trainingRecord.create({
      data: {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        courseId: input.courseId,
        completedAt: input.completedAt,
        expiresAt: expiresOn ? dateColumn(expiresOn) : null,
        evidenceReference: evidence.reference ?? null,
        evidenceFileName: evidence.fileName ?? null,
        evidenceContentType: evidence.contentType ?? null,
        evidenceSizeBytes: evidence.sizeBytes ?? null,
        evidenceChecksumSha256: evidence.checksumSha256 ?? null,
        notes: input.notes ?? null,
        recordedById: actor.userId,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_record.create",
      targetType: "TrainingRecord",
      targetId: row.id,
      newValue: { employeeId: row.employeeId, courseId: row.courseId, completedAt: row.completedAt.toISOString(), expiresAt: expiresOn, status: row.status, evidence },
    });
    return toRecordView(row);
  });
}

/** `GET /training/records/{id}` (`training.view` over the employee; out of scope is a 404). */
export async function getRecord(actor: Actor, recordId: string): Promise<RecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const row = await tx.trainingRecord.findFirst({ where: { id: recordId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    await enforceOverEmployee(tx, actor, "training.view", row.employeeId);
    return toRecordView(row);
  });
}

/** `GET /training/records`: records the caller may see, newest completion first. `status=PENDING_VERIFICATION` is HR's queue. */
export async function listRecords(actor: Actor, query: ListRecordsQuery): Promise<Page<RecordView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "training.view", now), "base");
    const callerWhere: Prisma.TrainingRecordWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await tx.trainingRecord.findMany({
      where: withinScope(buildScopeWhere(scope, recordScopeColumns, now), callerWhere),
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toRecordView), page: page.page };
  });
}
