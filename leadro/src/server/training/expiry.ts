import type { Prisma } from "@prisma/client";
import { addDays } from "@/lib/zoned-time";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { qualificationWarningDays } from "@/server/qualifications";
import { tenantCalendar } from "./access";
import type { ExpiringRecordsQuery } from "./schemas";
import { dateColumn, isoDateOf, recordScopeColumns, toRecordView, type RecordView } from "./views";

/**
 * Overdue assignments and expiring completions (§10.1 "expiry-aware", §14). The calendar is the company's: "today" is the
 * date in the tenant's default time zone; a completion is valid through the end of its `expiresAt` day, so one expiring
 * TODAY is still "expiring" (0 days left) and becomes "expired" tomorrow. An assignment is overdue from the day after its
 * due date.
 *
 * "Expiring" only counts a VERIFIED record that is the employee's latest word on the course: a record already superseded
 * by another verified record of the same course that lasts longer (or never expires) warns of nothing.
 */

/** Ids of VERIFIED records expiring on or before `horizon` that a longer-lasting verified record of the same course supersedes. */
async function supersededRecordIds(tx: TenantTx, tenantId: string, horizon: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT r.id FROM "TrainingRecord" r
    WHERE r."tenantId" = ${tenantId} AND r.status = 'VERIFIED' AND r."expiresAt" IS NOT NULL AND r."expiresAt" <= ${horizon}
      AND EXISTS (
        SELECT 1 FROM "TrainingRecord" n
        WHERE n."tenantId" = r."tenantId" AND n."employeeId" = r."employeeId" AND n."courseId" = r."courseId"
          AND n.status = 'VERIFIED' AND n.id <> r.id AND (n."expiresAt" IS NULL OR n."expiresAt" > r."expiresAt")
      )`;
  return rows.map((row) => row.id);
}

interface ExpiringWindow {
  /** Defaults to the tenant's `qualificationWarningDays` (the same horizon as credentials). */
  withinDays?: number;
  /** Also records already past their date (still VERIFIED). */
  includeExpired?: boolean;
  /** With `includeExpired`: only records expired at most this many days ago (unbounded when omitted). */
  lookBackDays?: number;
  now?: Date;
}

/** The where-fragment of "expiring" for one tenant, plus today's date. Terminated employees are left out. */
async function expiringWhere(tx: TenantTx, tenantId: string, window: ExpiringWindow): Promise<{ where: Prisma.TrainingRecordWhereInput; today: string }> {
  const { today } = await tenantCalendar(tx, tenantId, window.now);
  const withinDays = window.withinDays ?? (await qualificationWarningDays(tx, tenantId));
  const horizon = dateColumn(addDays(today, withinDays));
  const superseded = await supersededRecordIds(tx, tenantId, horizon);
  const earliest = !window.includeExpired ? today : window.lookBackDays !== undefined ? addDays(today, -window.lookBackDays) : null;
  return {
    today,
    where: {
      tenantId,
      status: "VERIFIED",
      expiresAt: { not: null, lte: horizon, ...(earliest ? { gte: dateColumn(earliest) } : {}) },
      employee: { status: { not: "TERMINATED" } },
      ...(superseded.length > 0 ? { id: { notIn: superseded } } : {}),
    },
  };
}

const DAY_MS = 86_400_000;
/** Whole days from `today` to `isoDate` (0 = today, negative = past). */
export const daysUntil = (today: string, isoDate: string): number => Math.round((dateColumn(isoDate).getTime() - dateColumn(today).getTime()) / DAY_MS);

export interface ExpiringTrainingRecord {
  recordId: string;
  employeeId: string;
  courseId: string;
  /** `YYYY-MM-DD`. */
  expiresOn: string;
  /** 0 = expires today (still valid through today); negative = already expired. */
  daysRemaining: number;
}

/**
 * System query (no actor) for the sweep: verified, not superseded completions expiring within the window, soonest first.
 * `afterId` continues a batch (ordered by expiry, then id).
 */
export async function findExpiringTrainingRecords(tx: TenantTx, tenantId: string, window: ExpiringWindow & { take?: number; afterId?: string } = {}): Promise<ExpiringTrainingRecord[]> {
  const { where, today } = await expiringWhere(tx, tenantId, window);
  const rows = await tx.trainingRecord.findMany({
    where,
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: { id: true, employeeId: true, courseId: true, expiresAt: true },
    ...(window.take ? { take: window.take } : {}),
    ...(window.afterId ? { cursor: { id: window.afterId }, skip: 1 } : {}),
  });
  return rows.map((row) => {
    const expiresOn = isoDateOf(row.expiresAt) as string; // the where-clause requires a date
    return { recordId: row.id, employeeId: row.employeeId, courseId: row.courseId, expiresOn, daysRemaining: daysUntil(today, expiresOn) };
  });
}

/** `GET /training/records/expiring`: the scoped list (HR, managers), soonest expiry first, each with `daysRemaining`. */
export async function listExpiringRecords(actor: Actor, query: ExpiringRecordsQuery): Promise<Page<RecordView & { daysRemaining: number }>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const now = new Date();
    const { where, today } = await expiringWhere(tx, actor.tenantId, { withinDays: query.withinDays, includeExpired: query.includeExpired, now });
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "training.view", now), "base");
    const callerWhere: Prisma.TrainingRecordWhereInput = {
      ...where,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
    };
    const rows = await tx.trainingRecord.findMany({
      where: withinScope(buildScopeWhere(scope, recordScopeColumns, now), callerWhere),
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({ ...toRecordView(row), daysRemaining: daysUntil(today, isoDateOf(row.expiresAt) as string) })),
      page: page.page,
    };
  });
}

export interface OverdueTrainingAssignment {
  assignmentId: string;
  employeeId: string;
  courseId: string;
  assignedById: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
}

/** System query (no actor) for the sweep: open assignments due before today, of employees not terminated. */
export async function findOverdueTrainingAssignments(tx: TenantTx, tenantId: string, options: { now?: Date; take?: number; afterId?: string } = {}): Promise<OverdueTrainingAssignment[]> {
  const { today } = await tenantCalendar(tx, tenantId, options.now);
  const rows = await tx.trainingAssignment.findMany({
    where: { tenantId, status: { in: ["ASSIGNED", "IN_PROGRESS"] }, dueDate: { lt: dateColumn(today) }, employee: { status: { not: "TERMINATED" } } },
    orderBy: [{ id: "asc" }],
    select: { id: true, employeeId: true, courseId: true, assignedById: true, dueDate: true },
    ...(options.take ? { take: options.take } : {}),
    ...(options.afterId ? { cursor: { id: options.afterId }, skip: 1 } : {}),
  });
  return rows.map((row) => ({ assignmentId: row.id, employeeId: row.employeeId, courseId: row.courseId, assignedById: row.assignedById, dueDate: isoDateOf(row.dueDate) as string }));
}
