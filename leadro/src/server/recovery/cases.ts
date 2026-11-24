import type { Prisma, RecoveryStatus } from "@prisma/client";
import { canTransitionRecovery, isClosedRecoveryStatus, isOpenRecoveryStatus, isRecoveryStatus, type RecoveryStatusValue } from "@/lib/recovery-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx, enforceInTx, projectFields, withinScope } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { assertCaseAccess, caseResourceRef, loadCaseRow, resolveCaseListAccess } from "./access";
import { ATTEMPT_FIELD_MAP, CASE_FIELD_MAP, attemptSelect, caseRowSelect, caseView, type CaseRow } from "./fields";
import { notifyCaseAssigned } from "./notify";
import { evaluatePresence } from "./presence";
import type { AssignCaseInput, ChangeCaseStatusInput, ListCasesQuery, RecordAttemptInput, RecoverCaseInput, SummaryQuery, UpdateCaseInput } from "./schemas";

/**
 * Recovery cases (§9.3 - 9.7). The engine creates them (`engine.ts`); people work them here. Every status change goes
 * through `src/lib/recovery-lifecycle.ts` and writes a `RecoveryCaseStatusHistory` row in the same transaction. The case row
 * is locked first, so two people acting on it queue up and the second sees the first one's result.
 */

const open = { allowed: true as const, fieldSets: ["base"] };
const project = (row: CaseRow) => projectFields(caseView(row), open, CASE_FIELD_MAP);

async function lockCase(tx: TenantTx, tenantId: string, caseId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "LeadRecoveryCase" WHERE id = ${caseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

async function reload(tx: TenantTx, tenantId: string, caseId: string): Promise<CaseRow> {
  const row = await loadCaseRow(tx, tenantId, caseId);
  if (!row) throw new NotFoundError();
  return row;
}

/** Applies a status change (history row included). The caller checked permissions and holds the row lock. */
async function moveStatus(
  tx: TenantTx,
  actor: Actor,
  current: { id: string; status: string },
  to: RecoveryStatusValue,
  extra: Prisma.LeadRecoveryCaseUncheckedUpdateInput,
  reason?: string,
): Promise<void> {
  if (!isRecoveryStatus(current.status) || !canTransitionRecovery(current.status, to)) {
    throw new InvalidStateTransitionError({ message: `A ${current.status} case cannot become ${to}.` });
  }
  const now = new Date();
  await tx.leadRecoveryCase.update({
    where: { id: current.id },
    data: {
      status: to as RecoveryStatus,
      statusChangedAt: now,
      ...(isClosedRecoveryStatus(to) ? { closedAt: now } : { closedAt: null, closeReason: null }),
      ...extra,
    },
  });
  await tx.recoveryCaseStatusHistory.create({
    data: { tenantId: actor.tenantId, caseId: current.id, fromStatus: current.status as RecoveryStatus, toStatus: to as RecoveryStatus, actorType: "USER", actorUserId: actor.userId, reason: reason ?? null, occurredAt: now },
  });
}

/** One case with its attempts and status history (both newest first). */
export async function getCase(actor: Actor, caseId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const { row } = await assertCaseAccess(tx, actor, caseId, "recovery.view");
    const [attempts, history, followUps] = await Promise.all([
      tx.recoveryAttempt.findMany({ where: { tenantId: actor.tenantId, caseId }, orderBy: [{ occurredAt: "desc" }, { id: "asc" }], select: attemptSelect }),
      tx.recoveryCaseStatusHistory.findMany({
        where: { tenantId: actor.tenantId, caseId },
        orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
        select: { id: true, fromStatus: true, toStatus: true, actorType: true, actorUserId: true, reason: true, occurredAt: true },
      }),
      tx.followUpTask.findMany({ where: { tenantId: actor.tenantId, recoveryCaseId: caseId }, orderBy: { dueAt: "asc" }, select: { id: true, status: true, dueAt: true } }),
    ]);
    return {
      ...project(row),
      attempts: attempts.map((attempt) => projectFields(attempt, open, ATTEMPT_FIELD_MAP)),
      statusHistory: history,
      followUps,
    };
  });
}

/** Cases in the caller's scope, newest outcome first. */
export async function listCases(actor: Actor, query: ListCasesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "recovery.view");
    const now = new Date();
    const access = await resolveCaseListAccess(tx, actor, "recovery.view", now);
    const assignee = query.assignedToId === "me" ? (actor.employeeId ?? "none") : query.assignedToId;
    const closedStatuses: RecoveryStatus[] = ["RECOVERED", "NOT_RECOVERED", "CLOSED"];
    const filters: Prisma.LeadRecoveryCaseWhereInput[] = [
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.open === "true" ? [{ status: { notIn: closedStatuses } }] : []),
      ...(query.open === "false" ? [{ status: { in: closedStatuses } }] : []),
      ...(query.priority ? [{ priority: query.priority }] : []),
      ...(assignee === "none" && query.assignedToId === "none" ? [{ assignedToId: null }] : assignee ? [{ assignedToId: assignee }] : []),
      ...(query.customerId ? [{ customerId: query.customerId }] : []),
      ...(query.jobId ? [{ jobId: query.jobId }] : []),
      ...(query.orgUnitId ? [{ orgUnitId: query.orgUnitId }] : []),
      ...(query.presenceStatus ? [{ presenceStatus: query.presenceStatus }] : []),
    ];
    const rows = await tx.leadRecoveryCase.findMany({
      where: withinScope(access.where, { tenantId: actor.tenantId, AND: filters }),
      select: caseRowSelect,
      orderBy: [{ outcomeAt: "desc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => projectFields(caseView(row, now), { allowed: true, fieldSets: access.fieldSetsOf(row) }, CASE_FIELD_MAP)), page: page.page };
  });
}

/** Gives the case to a recovery employee (or, with `assigneeId: null`, takes it back to NEW). Needs `recovery.assign`. */
export async function assignCase(actor: Actor, ctx: RequestContext, caseId: string, input: AssignCaseInput): Promise<Record<string, unknown>> {
  const notificationIds: string[] = [];
  const view = await withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.assign");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    if (!isRecoveryStatus(current.status) || !isOpenRecoveryStatus(current.status)) {
      throw new InvalidStateTransitionError({ message: `A ${current.status} case takes no new assignee.` });
    }
    const previousAssignee = current.assignedToId;

    if (input.assigneeId === null) {
      if (current.status === "ASSIGNED") await moveStatus(tx, actor, current, "NEW", { assignedToId: null, assignedAt: null }, "Unassigned");
      else await tx.leadRecoveryCase.update({ where: { id: caseId }, data: { assignedToId: null, assignedAt: null } });
    } else {
      const employee = await tx.employee.findFirst({ where: { id: input.assigneeId, tenantId: actor.tenantId, status: "ACTIVE" }, select: { id: true, userId: true } });
      if (!employee?.userId) throw new ValidationError({ message: "The assignee must be an active employee with a login.", field: "assigneeId" });
      // The assignee must be able to open the case, or it would land in a queue they cannot see.
      const decision = await canInTx(tx, { tenantId: actor.tenantId, userId: employee.userId }, "recovery.view", { ...caseResourceRef({ orgUnitId: current.orgUnitId, assignedToId: employee.id }) });
      if (!decision.allowed) throw new ValidationError({ message: "The assignee cannot work cases in this service area.", field: "assigneeId" });
      const stamp = { assignedToId: employee.id, assignedAt: new Date() };
      if (current.status === "NEW") await moveStatus(tx, actor, current, "ASSIGNED", stamp, "Assigned");
      else await tx.leadRecoveryCase.update({ where: { id: caseId }, data: stamp });
      if (employee.id !== previousAssignee) {
        notificationIds.push(
          ...(await notifyCaseAssigned(tx, actor.tenantId, { caseId, caseNumber: current.number, employeeId: employee.id, excludeUserId: actor.userId, anchor: `assigned:${stamp.assignedAt.getTime()}` })),
        );
      }
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.case_assign",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      previousValue: { assignedToId: previousAssignee },
      newValue: { assignedToId: input.assigneeId },
    });
    return project(await reload(tx, actor.tenantId, caseId));
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}

/** Moves a case along §9.5 (contacting, reached, follow-up required, not recovered, closed). Recovery has its own action. */
export async function changeCaseStatus(actor: Actor, ctx: RequestContext, caseId: string, input: ChangeCaseStatusInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.edit");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    const to = input.status as RecoveryStatusValue;
    if (isClosedRecoveryStatus(to) && !input.reason) {
      throw new ValidationError({ message: "Closing a case needs a reason (the final outcome).", field: "reason" });
    }
    await moveStatus(tx, actor, current, to, isClosedRecoveryStatus(to) ? { closeReason: input.reason } : {}, input.reason);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.case_status_change",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      previousValue: { status: current.status },
      newValue: { status: to, hasReason: Boolean(input.reason) },
    });
    return project(await reload(tx, actor.tenantId, caseId));
  });
}

/** Employee-entered estimate and priority. The estimate is never confirmed revenue (§9.7). */
export async function updateCase(actor: Actor, ctx: RequestContext, caseId: string, input: UpdateCaseInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.edit");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    if (!isRecoveryStatus(current.status) || !isOpenRecoveryStatus(current.status)) {
      throw new InvalidStateTransitionError({ message: "A finished case cannot be edited." });
    }
    await tx.leadRecoveryCase.update({
      where: { id: caseId },
      data: {
        ...(input.estimatedValueMinor !== undefined ? { estimatedValueMinor: input.estimatedValueMinor } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.case_update",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      previousValue: { estimatedValueMinor: current.estimatedValueMinor, priority: current.priority },
      newValue: { ...input },
    });
    return project(await reload(tx, actor.tenantId, caseId));
  });
}

/** Records one communication attempt (§9.3). A NEW or ASSIGNED case becomes CONTACTING with the first attempt. */
export async function recordAttempt(actor: Actor, ctx: RequestContext, caseId: string, input: RecordAttemptInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.edit");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    if (current.status === "CLOSED") throw new InvalidStateTransitionError({ message: "A closed case takes no attempts." });
    const now = new Date();
    const occurredAt = input.occurredAt ?? now;
    if (occurredAt.getTime() > now.getTime() + 60_000) throw new ValidationError({ message: "occurredAt cannot be in the future.", field: "occurredAt" });

    const attempt = await tx.recoveryAttempt.create({
      data: {
        tenantId: actor.tenantId,
        caseId,
        employeeId: actor.employeeId ?? null,
        channel: input.channel,
        outcome: input.outcome ?? null,
        occurredAt,
        durationSeconds: input.durationSeconds ?? null,
        notes: input.notes ?? null,
        offeredAmountMinor: input.offeredAmountMinor ?? null,
        recordedById: actor.userId,
      },
      select: attemptSelect,
    });
    const lastAttemptAt = current.lastAttemptAt && current.lastAttemptAt > occurredAt ? current.lastAttemptAt : occurredAt;
    await tx.leadRecoveryCase.update({ where: { id: caseId }, data: { attemptCount: { increment: 1 }, lastAttemptAt } });
    if (current.status === "NEW" || current.status === "ASSIGNED") await moveStatus(tx, actor, current, "CONTACTING", {}, "First contact attempt");
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.attempt_record",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      // The notes are free text about a customer: the trail records that they exist, not what they say.
      newValue: { attemptId: attempt.id, channel: input.channel, outcome: input.outcome ?? null, hasNotes: Boolean(input.notes), offeredAmountMinor: input.offeredAmountMinor ?? null },
    });
    return projectFields(attempt, open, ATTEMPT_FIELD_MAP);
  });
}

/**
 * Confirms the recovery (§9.7): stores the CONFIRMED amounts with `recoveredAt` and links the recovered work (a job and / or
 * lead of the same customer, never the case's own job) so the original customer, lead and job stay connected. The estimate
 * is left untouched: confirmed and estimated revenue never merge.
 */
export async function recoverCase(actor: Actor, ctx: RequestContext, caseId: string, input: RecoverCaseInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.edit");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    const now = new Date();
    const recoveredAt = input.recoveredAt ?? now;
    if (recoveredAt.getTime() > now.getTime() + 60_000) throw new ValidationError({ message: "recoveredAt cannot be in the future.", field: "recoveredAt" });
    if (input.collectedAmountMinor !== undefined && input.collectedAmountMinor > input.recoveredAmountMinor) {
      throw new ValidationError({ message: "The collected amount cannot exceed the recovered amount.", field: "collectedAmountMinor" });
    }
    if (input.recoveredJobId) {
      if (input.recoveredJobId === current.jobId) throw new ValidationError({ message: "Recovered work must be new work, not the original job.", field: "recoveredJobId" });
      const job = await tx.job.findFirst({ where: { id: input.recoveredJobId, tenantId: actor.tenantId, customerId: current.customerId }, select: { id: true } });
      if (!job) throw new ValidationError({ message: "The recovered job does not exist for this customer.", field: "recoveredJobId" });
    }
    if (input.recoveredLeadId) {
      const lead = await tx.lead.findFirst({ where: { id: input.recoveredLeadId, tenantId: actor.tenantId, customerId: current.customerId }, select: { id: true } });
      if (!lead) throw new ValidationError({ message: "The recovered lead does not exist for this customer.", field: "recoveredLeadId" });
    }
    await moveStatus(
      tx,
      actor,
      current,
      "RECOVERED",
      {
        recoveredAt,
        recoveredAmountMinor: input.recoveredAmountMinor,
        collectedAmountMinor: input.collectedAmountMinor ?? null,
        recoveredJobId: input.recoveredJobId ?? null,
        recoveredLeadId: input.recoveredLeadId ?? null,
        recoveredById: actor.userId,
      },
      input.note,
    );
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.case_recover",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      previousValue: { status: current.status },
      newValue: {
        status: "RECOVERED",
        recoveredAmountMinor: input.recoveredAmountMinor,
        collectedAmountMinor: input.collectedAmountMinor ?? null,
        recoveredJobId: input.recoveredJobId ?? null,
        recoveredLeadId: input.recoveredLeadId ?? null,
        currency: current.currency,
      },
    });
    return project(await reload(tx, actor.tenantId, caseId));
  });
}

/** Re-evaluates the technician's presence now and stores the new snapshot (status, accuracy, reason: never a position). */
export async function refreshPresence(actor: Actor, ctx: RequestContext, caseId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertCaseAccess(tx, actor, caseId, "recovery.edit");
    await lockCase(tx, actor.tenantId, caseId);
    const current = await reload(tx, actor.tenantId, caseId);
    const presence = await evaluatePresence(tx, actor.tenantId, { technicianId: current.technicianId, jobId: current.jobId });
    await tx.leadRecoveryCase.update({
      where: { id: caseId },
      data: {
        presenceStatus: presence.status,
        presenceEvaluatedAt: presence.evaluatedAt,
        presenceLocationEventId: presence.locationEventId,
        presenceAccuracyM: presence.accuracyM,
        presenceDistanceM: presence.distanceM,
        presenceReason: presence.reason,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "recovery.presence_refresh",
      targetType: "LeadRecoveryCase",
      targetId: caseId,
      previousValue: { presenceStatus: current.presenceStatus },
      newValue: { presenceStatus: presence.status, presenceReason: presence.reason, accuracyM: presence.accuracyM },
    });
    return project(await reload(tx, actor.tenantId, caseId));
  });
}

/**
 * Recovery results for the caller's scope, per currency (§9.7): CONFIRMED revenue (recovered cases with `recoveredAt`) and
 * ESTIMATED value (still-open cases) are separate figures and are never added together.
 */
export async function recoverySummary(actor: Actor, query: SummaryQuery): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "recovery.view");
    const access = await resolveCaseListAccess(tx, actor, "recovery.view", new Date());
    const base: Prisma.LeadRecoveryCaseWhereInput = withinScope(access.where, { tenantId: actor.tenantId, ...(query.orgUnitId ? { orgUnitId: query.orgUnitId } : {}) });
    const created = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) };
    const inRange: Prisma.LeadRecoveryCaseWhereInput = Object.keys(created).length > 0 ? { outcomeAt: created } : {};
    const byStatus = await tx.leadRecoveryCase.groupBy({ by: ["status"], where: withinScope(base, inRange), _count: { _all: true } });
    const confirmed = await tx.leadRecoveryCase.groupBy({
      by: ["currency"],
      where: withinScope(base, { ...inRange, status: { in: ["RECOVERED", "CLOSED"] }, recoveredAt: { not: null } }),
      _sum: { recoveredAmountMinor: true, collectedAmountMinor: true },
      _count: { _all: true },
    });
    const estimated = await tx.leadRecoveryCase.groupBy({
      by: ["currency"],
      where: withinScope(base, { ...inRange, status: { notIn: ["RECOVERED", "NOT_RECOVERED", "CLOSED"] } }),
      _sum: { estimatedValueMinor: true },
      _count: { _all: true },
    });
    return {
      casesByStatus: Object.fromEntries(byStatus.map((entry) => [entry.status, entry._count._all])),
      confirmed: confirmed.map((entry) => ({ currency: entry.currency, cases: entry._count._all, recoveredAmountMinor: entry._sum.recoveredAmountMinor ?? 0, collectedAmountMinor: entry._sum.collectedAmountMinor ?? 0 })),
      estimated: estimated.map((entry) => ({ currency: entry.currency, openCases: entry._count._all, estimatedValueMinor: entry._sum.estimatedValueMinor ?? 0 })),
    };
  });
}
