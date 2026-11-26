import { z } from "zod";
import { pageArgs, pageQuerySchema, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { tenantCalendar } from "./access";
import { TRAINING_ASSIGNMENT_STATUSES, TRAINING_RECORD_STATUSES } from "./schemas";
import { toAssignmentView, toRecordView, type AssignmentView, type RecordView } from "./views";

/**
 * Self-service (spec 5.11 "training records", `/api/v1/me/training/*`): the caller's OWN assignments and records, in every
 * status. No module permission: the query is filtered on the caller's employee record (a user without one sees nothing),
 * so a Dispatcher or Customer Relations agent, who holds no `training.view`, still sees their own training. Each row
 * carries the course's code and name, because the course catalog itself needs `training.view`.
 */

const id = z.string().trim().min(1).max(64);

export const ownAssignmentsQuerySchema = pageQuerySchema
  .extend({ status: z.enum(TRAINING_ASSIGNMENT_STATUSES).optional(), courseId: id.optional() })
  .strict();
export type OwnAssignmentsQuery = z.infer<typeof ownAssignmentsQuerySchema>;

export const ownRecordsQuerySchema = pageQuerySchema
  .extend({ status: z.enum(TRAINING_RECORD_STATUSES).optional(), courseId: id.optional() })
  .strict();
export type OwnRecordsQuery = z.infer<typeof ownRecordsQuerySchema>;

const courseSelect = { select: { id: true, code: true, name: true, category: true, certificationId: true } } as const;
interface CourseSummary {
  id: string;
  code: string;
  name: string;
  category: string | null;
  certificationId: string | null;
}

export type OwnAssignmentView = AssignmentView & { course: CourseSummary };
export type OwnRecordView = RecordView & { course: CourseSummary };

/** `GET /me/training/assignments`: the caller's assignments, soonest due first (no due date last), with `overdue`. */
export async function listOwnAssignments(actor: Actor, query: OwnAssignmentsQuery): Promise<Page<OwnAssignmentView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const { today } = await tenantCalendar(tx, actor.tenantId);
    const rows = await tx.trainingAssignment.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.courseId ? { courseId: query.courseId } : {}),
      },
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      include: { course: courseSelect },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(({ course, ...row }) => ({ ...toAssignmentView(row, today), course })), page: page.page };
  });
}

/** `GET /me/training/records`: the caller's completions (pending, verified, rejected, revoked), newest first, with expiry. */
export async function listOwnRecords(actor: Actor, query: OwnRecordsQuery): Promise<Page<OwnRecordView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.trainingRecord.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.courseId ? { courseId: query.courseId } : {}),
      },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      include: { course: courseSelect },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(({ course, ...row }) => ({ ...toRecordView(row), course })), page: page.page };
  });
}
