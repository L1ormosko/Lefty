import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import { conflictOnUniqueViolation, ConflictError, ForbiddenError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, ValidationError, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { enforceOverEmployee, loadActiveEmployee, lockRow, tenantCalendar } from "./access";
import { notifyTraining } from "./notify";
import type { AssignTrainingInput, CancelAssignmentInput, ListAssignmentsQuery, UpdateAssignmentInput } from "./schemas";
import { assignmentScopeColumns, dateColumn, isoDateOf, toAssignmentView, type AssignmentView } from "./views";

/**
 * Training assignments (§10.1, §5.4 "recommend training", §5.8): a course assigned to an employee with an optional due
 * date. ASSIGNED -> IN_PROGRESS -> COMPLETED (by HR verifying a completion, `verification.ts`), or -> CANCELLED with a
 * reason. One open assignment per employee and course (409). Overdue is derived from the tenant-local date.
 */

export const ALREADY_OPEN = "This employee already has an open assignment for this course.";
const OPEN_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const;

export interface CreateTrainingAssignmentInput {
  employeeId: string;
  courseId: string;
  /** `YYYY-MM-DD`, tenant-local, today or later; null / omitted = no deadline. */
  dueDate?: string | null;
  note?: string | null;
  source: "MANUAL" | "RECOMMENDATION";
  /** Required exactly when `source` is RECOMMENDATION: the accepted recommendation (same employee and course). */
  recommendationId?: string | null;
}

/**
 * Creates an assignment inside the caller's transaction, audits it and notifies the employee. NO permission check: the
 * caller has authorized itself (`assignTraining` checks `training.assign`; Task 5's recommendation acceptance does the
 * same before calling this with `source = RECOMMENDATION`).
 *
 * A concurrent duplicate can still hit the `training_assignment_one_open` unique index, which aborts the transaction:
 * wrap the caller's `withTenant` in `conflictOnUniqueViolation(ALREADY_OPEN, ...)` to answer 409.
 *
 * @returns the assignment and the created notification ids (deliver them with `deliverAfterCommit` after commit)
 * @throws ValidationError | InvalidStateTransitionError | ConflictError (an open assignment exists)
 */
export async function createTrainingAssignmentInTx(
  tx: TenantTx,
  ctx: RequestContext,
  input: CreateTrainingAssignmentInput,
): Promise<{ assignment: AssignmentView; notificationIds: string[] }> {
  if (!ctx.actor) throw new Error("createTrainingAssignmentInTx requires an authenticated actor");
  const { tenantId, userId } = ctx.actor;
  if ((input.source === "RECOMMENDATION") !== Boolean(input.recommendationId)) {
    throw new ValidationError({ message: "A recommendation id is required exactly for assignments from a recommendation.", field: "recommendationId" });
  }
  const employee = await loadActiveEmployee(tx, tenantId, input.employeeId);
  const course = await tx.trainingCourse.findFirst({ where: { id: input.courseId, tenantId }, select: { active: true } });
  if (!course) throw new ValidationError({ message: "Unknown course.", field: "courseId" });
  if (!course.active) throw new ValidationError({ message: "This course is archived.", field: "courseId" });
  const { today } = await tenantCalendar(tx, tenantId);
  if (input.dueDate && input.dueDate < today) throw new ValidationError({ message: "The due date is in the past.", field: "dueDate" });
  const open = await tx.trainingAssignment.findFirst({
    where: { tenantId, employeeId: input.employeeId, courseId: input.courseId, status: { in: [...OPEN_STATUSES] } },
    select: { id: true },
  });
  if (open) throw new ConflictError({ message: ALREADY_OPEN, details: [{ field: "courseId", code: "training.already_open", message: ALREADY_OPEN }] });

  const row = await tx.trainingAssignment.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      courseId: input.courseId,
      dueDate: input.dueDate ? dateColumn(input.dueDate) : null,
      note: input.note ?? null,
      source: input.source,
      recommendationId: input.recommendationId ?? null,
      assignedById: userId,
    },
  });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "training_assignment.create",
    targetType: "TrainingAssignment",
    targetId: row.id,
    newValue: { employeeId: row.employeeId, courseId: row.courseId, dueDate: isoDateOf(row.dueDate), source: row.source, recommendationId: row.recommendationId },
  });
  const notificationIds = await notifyTraining(tx, tenantId, {
    eventType: "training.assigned",
    targetId: row.id,
    employeeId: row.employeeId,
    anchor: "assigned",
    recipientUserIds: [employee.userId],
    excludeUserId: userId,
  });
  return { assignment: toAssignmentView(row, today), notificationIds };
}

/** `POST /training/assignments`: assigns a course by hand (`training.assign` over the employee). */
export async function assignTraining(actor: Actor, ctx: RequestContext, input: AssignTrainingInput): Promise<AssignmentView> {
  const result = await conflictOnUniqueViolation(ALREADY_OPEN, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceOverEmployee(tx, actor, "training.assign", input.employeeId);
      return createTrainingAssignmentInTx(tx, ctx, { ...input, source: "MANUAL" });
    }),
  );
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return result.assignment;
}

/** Loads an assignment for a change: capability first (403 must not depend on the id), then scope (404). Locked. */
async function loadForChange(tx: TenantTx, actor: Actor, assignmentId: string) {
  await enforceInTx(tx, actor, "training.edit");
  await lockRow(tx, "TrainingAssignment", actor.tenantId, assignmentId);
  const row = await tx.trainingAssignment.findFirstOrThrow({ where: { id: assignmentId, tenantId: actor.tenantId } });
  await enforceOverEmployee(tx, actor, "training.edit", row.employeeId);
  // Review P5-R2: what someone's manager assigned them is not theirs to reschedule or cancel (same principle as
  // `assertNotOwnRecord` for verifications).
  if (actor.employeeId !== null && row.employeeId === actor.employeeId) {
    throw new ForbiddenError({ message: "You cannot change a training assignment of your own." });
  }
  if (row.status !== "ASSIGNED" && row.status !== "IN_PROGRESS") {
    throw new InvalidStateTransitionError({ message: `A ${row.status.toLowerCase()} assignment cannot change.` });
  }
  return row;
}

/** `PATCH /training/assignments/{id}`: due date and note of an open assignment (`training.edit`). */
export async function updateAssignment(actor: Actor, ctx: RequestContext, assignmentId: string, input: UpdateAssignmentInput): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForChange(tx, actor, assignmentId);
    const { today } = await tenantCalendar(tx, actor.tenantId);
    if (input.dueDate && input.dueDate < today) throw new ValidationError({ message: "The due date is in the past.", field: "dueDate" });
    const { changedKeys, previous, next } = changedFields({ dueDate: isoDateOf(before.dueDate), note: before.note }, input);
    if (changedKeys.length === 0) return toAssignmentView(before, today);
    const row = await tx.trainingAssignment.update({
      where: { id: assignmentId },
      data: {
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? dateColumn(input.dueDate) : null } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "training_assignment.update", targetType: "TrainingAssignment", targetId: row.id, previousValue: previous, newValue: next });
    return toAssignmentView(row, today);
  });
}

/** `POST /training/assignments/{id}/start`: ASSIGNED -> IN_PROGRESS (`training.edit`). */
export async function startAssignment(actor: Actor, ctx: RequestContext, assignmentId: string): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForChange(tx, actor, assignmentId);
    if (before.status !== "ASSIGNED") throw new InvalidStateTransitionError({ message: "The assignment is already in progress." });
    const row = await tx.trainingAssignment.update({ where: { id: assignmentId }, data: { status: "IN_PROGRESS" } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_assignment.start",
      targetType: "TrainingAssignment",
      targetId: row.id,
      previousValue: { status: before.status },
      newValue: { status: row.status },
    });
    return toAssignmentView(row, (await tenantCalendar(tx, actor.tenantId)).today);
  });
}

/** `POST /training/assignments/{id}/cancel`: an open assignment -> CANCELLED with a reason (`training.edit`). */
export async function cancelAssignment(actor: Actor, ctx: RequestContext, assignmentId: string, input: CancelAssignmentInput): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForChange(tx, actor, assignmentId);
    const row = await tx.trainingAssignment.update({
      where: { id: assignmentId },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.userId, cancelReason: input.reason },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_assignment.cancel",
      targetType: "TrainingAssignment",
      targetId: row.id,
      previousValue: { status: before.status },
      newValue: { status: row.status },
      reason: input.reason,
    });
    return toAssignmentView(row, (await tenantCalendar(tx, actor.tenantId)).today);
  });
}

/** `GET /training/assignments/{id}` (`training.view` over the employee; out of scope is a 404). */
export async function getAssignment(actor: Actor, assignmentId: string): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const row = await tx.trainingAssignment.findFirst({ where: { id: assignmentId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    await enforceOverEmployee(tx, actor, "training.view", row.employeeId);
    return toAssignmentView(row, (await tenantCalendar(tx, actor.tenantId)).today);
  });
}

/**
 * `GET /training/assignments`: assignments the caller may see (the employee's scope is part of the query), soonest due
 * first (no due date last). `overdue=true`: open and due before the tenant-local today.
 */
export async function listAssignments(actor: Actor, query: ListAssignmentsQuery): Promise<Page<AssignmentView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const now = new Date();
    const { today } = await tenantCalendar(tx, actor.tenantId, now);
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "training.view", now), "base");
    const callerWhere: Prisma.TrainingAssignmentWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.overdue ? { AND: [{ status: { in: [...OPEN_STATUSES] } }, { dueDate: { lt: dateColumn(today) } }] } : {}),
    };
    const rows = await tx.trainingAssignment.findMany({
      where: withinScope(buildScopeWhere(scope, assignmentScopeColumns, now), callerWhere),
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => toAssignmentView(row, today)), page: page.page };
  });
}
