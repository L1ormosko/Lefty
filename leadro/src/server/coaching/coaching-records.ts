import type { CoachingRecord, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import {
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assertMetricValueOfEmployee, assertNotAboutSelf, isAboutCaller, lockRow, notAboutCaller, textDigest, viaEmployee } from "./access";
import type { CreateCoachingRecordInput, ListCoachingRecordsQuery, UpdateCoachingRecordInput } from "./schemas";

/**
 * Coaching records (spec 10.4 "coaching notes", 22.2 sensitive): a manager's or HR's note about one employee, private by
 * default, shared with the employee explicitly (one way: what the employee was shown stays shown). Permissions:
 * `coaching.view` / `.create` / `.edit` over the EMPLOYEE (docs/PERMISSIONS.md section 12); their `view` is sensitive.
 *
 * - The employee and the author never change (DB trigger); records are archived, never deleted (DB trigger).
 * - Only the author edits the text, and only while the note is private and not archived. Once shared, the text changes only
 *   through an upheld data challenge (`supersedeCoachingRecordInTx`): the note is archived and a corrected copy is created,
 *   so the version the employee challenged is kept.
 * - No free text in audit events: a text change is recorded as its SHA-256 digest (`bodySha256`).
 */

const VIEW = "coaching.view";

export type CoachingRecordView = Omit<CoachingRecord, "tenantId">;
export function toCoachingRecordView(record: CoachingRecord): CoachingRecordView {
  const { tenantId: _tenantId, ...view } = record;
  return view;
}

const coachingScopeColumns = viaEmployee<Prisma.CoachingRecordWhereInput>((employee) => ({ employee }));

/** A little clock skew is tolerated; a conversation "next week" is not. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
function assertNotFuture(occurredAt: Date | undefined): void {
  if (occurredAt && occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    throw new ValidationError({ message: "A coaching conversation cannot be in the future.", field: "occurredAt" });
  }
}

/** What an audit event may say about a record: ids, flags, times and the text digest (never the text). */
const auditValue = (record: CoachingRecord) => ({
  employeeId: record.employeeId,
  metricValueId: record.metricValueId,
  occurredAt: record.occurredAt.toISOString(),
  sharedWithEmployee: record.sharedWithEmployee,
  archived: record.archivedAt !== null,
  bodySha256: textDigest(record.body),
});

/**
 * Loads (and row-locks) a record the actor may act on with `permission`. Reading it is the precondition of acting on it,
 * and both checks are over the record's employee, so a record outside the scope is a 404 (no existence leak).
 */
async function loadForAction(tx: TenantTx, actor: Actor, recordId: string, permission: string): Promise<CoachingRecord> {
  await enforceInTx(tx, actor, permission);
  await lockRow(tx, "CoachingRecord", recordId, actor.tenantId);
  const record = await tx.coachingRecord.findFirst({ where: { id: recordId, tenantId: actor.tenantId } });
  // A note about the caller does not exist for them here (review P5-R1/R2): not readable, so not changeable either.
  if (!record || isAboutCaller(actor, record.employeeId)) throw new NotFoundError();
  await enforceInTx(tx, actor, VIEW, { employeeId: record.employeeId });
  await enforceInTx(tx, actor, permission, { employeeId: record.employeeId });
  return record;
}

/** Writes a coaching note about an employee in the caller's scope (`coaching.create`). Private unless `shareWithEmployee`. */
export async function createCoachingRecord(actor: Actor, ctx: RequestContext, input: CreateCoachingRecordInput): Promise<CoachingRecordView> {
  assertNotFuture(input.occurredAt);
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "coaching.create", { employeeId: input.employeeId });
    assertNotAboutSelf(actor, input.employeeId);
    if (input.metricValueId) await assertMetricValueOfEmployee(tx, actor.tenantId, input.metricValueId, input.employeeId);
    const now = new Date();
    const shared = input.shareWithEmployee === true;
    const record = await tx.coachingRecord.create({
      data: {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        authorId: actor.userId,
        body: input.body,
        occurredAt: input.occurredAt ?? now,
        metricValueId: input.metricValueId ?? null,
        sharedWithEmployee: shared,
        sharedAt: shared ? now : null,
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "coaching_record.create", targetType: "CoachingRecord", targetId: record.id, newValue: auditValue(record) });
    return toCoachingRecordView(record);
  });
}

/** The author edits the text or the time of a PRIVATE, non-archived note (`coaching.edit`). */
export async function updateCoachingRecord(
  actor: Actor,
  ctx: RequestContext,
  recordId: string,
  input: UpdateCoachingRecordInput,
): Promise<CoachingRecordView> {
  assertNotFuture(input.occurredAt);
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, recordId, "coaching.edit");
    if (before.authorId !== actor.userId) throw new ForbiddenError({ message: "Only the author can edit a coaching note." });
    if (before.archivedAt) throw new InvalidStateTransitionError({ message: "An archived coaching note cannot be edited." });
    if (before.sharedWithEmployee) {
      throw new InvalidStateTransitionError({
        message: "A coaching note shared with the employee cannot be edited; a correction goes through a data challenge.",
      });
    }
    const after = await tx.coachingRecord.update({
      where: { id: before.id },
      data: { ...(input.body !== undefined ? { body: input.body } : {}), ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}) },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "coaching_record.update",
      targetType: "CoachingRecord",
      targetId: after.id,
      previousValue: auditValue(before),
      newValue: auditValue(after),
    });
    return toCoachingRecordView(after);
  });
}

/** Shares a note with its employee (`coaching.edit`). One way, idempotent for an already shared note. */
export async function shareCoachingRecord(actor: Actor, ctx: RequestContext, recordId: string): Promise<CoachingRecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, recordId, "coaching.edit");
    if (before.sharedWithEmployee) return toCoachingRecordView(before);
    if (before.archivedAt) throw new InvalidStateTransitionError({ message: "An archived coaching note cannot be shared." });
    const after = await tx.coachingRecord.update({ where: { id: before.id }, data: { sharedWithEmployee: true, sharedAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "coaching_record.share",
      targetType: "CoachingRecord",
      targetId: after.id,
      previousValue: { sharedWithEmployee: false },
      newValue: { sharedWithEmployee: true },
    });
    return toCoachingRecordView(after);
  });
}

/** Archives a note (`coaching.edit`): it stays readable to the chain and HR (`includeArchived`), it is never deleted. */
export async function archiveCoachingRecord(actor: Actor, ctx: RequestContext, recordId: string): Promise<CoachingRecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, recordId, "coaching.edit");
    if (before.archivedAt) return toCoachingRecordView(before);
    const after = await tx.coachingRecord.update({ where: { id: before.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "coaching_record.archive",
      targetType: "CoachingRecord",
      targetId: after.id,
      previousValue: { archived: false },
      newValue: { archived: true },
    });
    return toCoachingRecordView(after);
  });
}

/** One record (`coaching.view` over its employee; 404 outside the scope). */
export async function getCoachingRecord(actor: Actor, recordId: string): Promise<CoachingRecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const record = await tx.coachingRecord.findFirst({ where: { id: recordId, tenantId: actor.tenantId } });
    // Notes about the caller are read through self-service only (shared ones), never through a management grant (P5-R1).
    if (!record || isAboutCaller(actor, record.employeeId)) throw new NotFoundError();
    await enforceInTx(tx, actor, VIEW, { employeeId: record.employeeId });
    return toCoachingRecordView(record);
  });
}

/** Records in the caller's `coaching.view` scope, newest conversation first. Archived ones only with `includeArchived=true`. */
export async function listCoachingRecords(actor: Actor, query: ListCoachingRecordsQuery): Promise<Page<CoachingRecordView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const now = new Date();
    const scope = await resolveScope(tx, actor, VIEW, now);
    const callerWhere: Prisma.CoachingRecordWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.metricValueId ? { metricValueId: query.metricValueId } : {}),
      ...(query.shared !== undefined ? { sharedWithEmployee: query.shared } : {}),
      ...(query.includeArchived ? {} : { archivedAt: null }),
      // Never the caller's own notes (P5-R1): they read the shared ones through `/api/v1/me/coaching-notes`.
      AND: [notAboutCaller(actor)],
    };
    const rows = await tx.coachingRecord.findMany({
      where: withinScope(buildScopeWhere(scope, coachingScopeColumns, now), callerWhere),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toCoachingRecordView), page: page.page };
  });
}

export interface SupersedeCoachingRecordInput {
  tenantId: string;
  coachingRecordId: string;
  /** The employee the caller expects the record to be about (the challenge's employee). */
  employeeId: string;
  /** The corrected text. */
  body: string;
  /** The data challenge this correction settles (audited). */
  challengeId: string;
  ctx: RequestContext;
}

/**
 * The coaching module's correction API for an UPHELD data challenge (called by `data-challenges` inside ITS transaction,
 * after it authorized the reviewer). The challenged note is archived and a corrected copy (same employee, time, linked
 * value, sharing) is created with the reviewer as author, so the version the employee challenged is kept, not overwritten.
 * Audits `coaching_record.correct` on the original (with the new record's id and the challenge id) and returns that
 * audit event id, which the challenge stores as proof of the correction.
 */
export async function supersedeCoachingRecordInTx(
  tx: TenantTx,
  input: SupersedeCoachingRecordInput,
): Promise<{ auditEventId: string; correctedRecord: CoachingRecordView }> {
  const actorUserId = input.ctx.actor?.userId;
  if (!actorUserId) throw new ForbiddenError();
  await lockRow(tx, "CoachingRecord", input.coachingRecordId, input.tenantId);
  const original = await tx.coachingRecord.findFirst({ where: { id: input.coachingRecordId, tenantId: input.tenantId, employeeId: input.employeeId } });
  if (!original) throw new NotFoundError();
  if (original.archivedAt) throw new InvalidStateTransitionError({ message: "The coaching note was archived; it cannot be corrected any more." });
  const now = new Date();
  const corrected = await tx.coachingRecord.create({
    data: {
      tenantId: input.tenantId,
      employeeId: original.employeeId,
      authorId: actorUserId,
      body: input.body,
      occurredAt: original.occurredAt,
      metricValueId: original.metricValueId,
      sharedWithEmployee: original.sharedWithEmployee,
      sharedAt: original.sharedWithEmployee ? now : null,
    },
  });
  await tx.coachingRecord.update({ where: { id: original.id }, data: { archivedAt: now } });
  const auditEventId = await recordAudit(tx, {
    ...auditContextFields(input.ctx),
    action: "coaching_record.correct",
    targetType: "CoachingRecord",
    targetId: original.id,
    previousValue: { archived: false, bodySha256: textDigest(original.body) },
    newValue: { archived: true, correctedRecordId: corrected.id, correctedBodySha256: textDigest(corrected.body), dataChallengeId: input.challengeId },
  });
  return { auditEventId, correctedRecord: toCoachingRecordView(corrected) };
}
