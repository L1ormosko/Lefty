import type { MetricContextNote, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { COACHING_FIELD_SET, assertCoachingFields, assertNotAboutSelf, loadMetricValueFacts, lockRow, textDigest, viaEmployee } from "./access";
import type { CreateContextNoteInput, ListContextNotesQuery } from "./schemas";

/**
 * Manager context notes on metric values (spec 10.4 "managers can add context"), e.g. "two of these jobs waited for parts".
 * A note is about one metric value (same employee, composite FK) or about a period of one employee.
 *
 * Permissions: the performance module's own grants, because a note sits next to the numbers: `performance.edit` to write,
 * share or archive, `performance.view` to read, and in both cases the matching grant must name the `coaching` field set
 * (`performance.coaching_fields`, spec 22.2): the COO's plain `performance.view` reads values but never these notes.
 *
 * Rules: text, subject and author are frozen (DB trigger), so a note is never rewritten; a wrong note is archived and a new
 * one written. Not shared with the employee by default (ruling 8); sharing is one way. Never deleted. No free text in audit.
 */

const READ = "performance.view";
const WRITE = "performance.edit";

export type ContextNoteView = Omit<MetricContextNote, "tenantId">;
export function toContextNoteView(note: MetricContextNote): ContextNoteView {
  const { tenantId: _tenantId, ...view } = note;
  return view;
}

const noteScopeColumns = viaEmployee<Prisma.MetricContextNoteWhereInput>((employee) => ({ employee }));

/** Loads (and row-locks) a note the actor may change: read access with the coaching set first (404), then write with it. */
async function loadForAction(tx: TenantTx, actor: Actor, noteId: string): Promise<MetricContextNote> {
  await enforceInTx(tx, actor, WRITE);
  await lockRow(tx, "MetricContextNote", noteId, actor.tenantId);
  const note = await tx.metricContextNote.findFirst({ where: { id: noteId, tenantId: actor.tenantId } });
  if (!note) throw new NotFoundError();
  const read = await enforceInTx(tx, actor, READ, { employeeId: note.employeeId });
  // Without the coaching set the note does not exist for the caller (a 404 like any other out-of-scope record).
  if (!read.fieldSets.includes(COACHING_FIELD_SET)) throw new NotFoundError();
  assertCoachingFields(await enforceInTx(tx, actor, WRITE, { employeeId: note.employeeId }));
  return note;
}

/**
 * Adds context to a metric value (`metricValueId`) or to a period of an employee. Needs `performance.edit` with the
 * `coaching` set over the employee; nobody writes context about themselves.
 */
export async function createContextNote(actor: Actor, ctx: RequestContext, input: CreateContextNoteInput): Promise<ContextNoteView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, WRITE);
    let employeeId: string;
    if (input.metricValueId) {
      const value = await loadMetricValueFacts(tx, actor.tenantId, input.metricValueId);
      if (!value) throw new ValidationError({ message: "The metric value does not exist.", field: "metricValueId" });
      if (input.employeeId && input.employeeId !== value.employeeId) {
        throw new ValidationError({ message: "The metric value is not this employee's.", field: "employeeId" });
      }
      employeeId = value.employeeId;
    } else {
      // The schema guarantees employeeId + period when there is no value.
      employeeId = input.employeeId as string;
    }
    assertCoachingFields(await enforceInTx(tx, actor, WRITE, { employeeId }));
    assertNotAboutSelf(actor, employeeId);

    const now = new Date();
    const shared = input.shareWithEmployee === true;
    const note = await tx.metricContextNote.create({
      data: {
        tenantId: actor.tenantId,
        employeeId,
        metricValueId: input.metricValueId ?? null,
        periodStart: input.metricValueId ? null : (input.periodStart ?? null),
        periodEnd: input.metricValueId ? null : (input.periodEnd ?? null),
        body: input.body,
        authorId: actor.userId,
        sharedWithEmployee: shared,
        sharedAt: shared ? now : null,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "metric_context_note.create",
      targetType: "MetricContextNote",
      targetId: note.id,
      newValue: {
        employeeId,
        metricValueId: note.metricValueId,
        periodStart: note.periodStart?.toISOString().slice(0, 10) ?? null,
        periodEnd: note.periodEnd?.toISOString().slice(0, 10) ?? null,
        sharedWithEmployee: shared,
        bodySha256: textDigest(note.body),
      },
    });
    return toContextNoteView(note);
  });
}

/** Shares a note with its employee. One way; idempotent for an already shared note; an archived note cannot be shared. */
export async function shareContextNote(actor: Actor, ctx: RequestContext, noteId: string): Promise<ContextNoteView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, noteId);
    if (before.sharedWithEmployee) return toContextNoteView(before);
    if (before.archivedAt) throw new InvalidStateTransitionError({ message: "An archived context note cannot be shared." });
    const after = await tx.metricContextNote.update({ where: { id: before.id }, data: { sharedWithEmployee: true, sharedAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "metric_context_note.share",
      targetType: "MetricContextNote",
      targetId: after.id,
      previousValue: { sharedWithEmployee: false },
      newValue: { sharedWithEmployee: true },
    });
    return toContextNoteView(after);
  });
}

/** Archives a note (it is never deleted). Idempotent. */
export async function archiveContextNote(actor: Actor, ctx: RequestContext, noteId: string): Promise<ContextNoteView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, noteId);
    if (before.archivedAt) return toContextNoteView(before);
    const after = await tx.metricContextNote.update({ where: { id: before.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "metric_context_note.archive",
      targetType: "MetricContextNote",
      targetId: after.id,
      previousValue: { archived: false },
      newValue: { archived: true },
    });
    return toContextNoteView(after);
  });
}

/** One note (`performance.view` with the coaching set over its employee; 404 otherwise). */
export async function getContextNote(actor: Actor, noteId: string): Promise<ContextNoteView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, READ);
    const note = await tx.metricContextNote.findFirst({ where: { id: noteId, tenantId: actor.tenantId } });
    if (!note) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, READ, { employeeId: note.employeeId });
    if (!decision.fieldSets.includes(COACHING_FIELD_SET)) throw new NotFoundError();
    return toContextNoteView(note);
  });
}

/**
 * Notes the caller may read: only the scope of `performance.view` grants that name the coaching set counts, so a plain
 * grant yields an empty page rather than coaching content. Newest first; archived only with `includeArchived=true`.
 */
export async function listContextNotes(actor: Actor, query: ListContextNotesQuery): Promise<Page<ContextNoteView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, READ);
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, READ, now), COACHING_FIELD_SET);
    const callerWhere: Prisma.MetricContextNoteWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.metricValueId ? { metricValueId: query.metricValueId } : {}),
      ...(query.includeArchived ? {} : { archivedAt: null }),
    };
    const rows = await tx.metricContextNote.findMany({
      where: withinScope(buildScopeWhere(scope, noteScopeColumns, now), callerWhere),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toContextNoteView), page: page.page };
  });
}
