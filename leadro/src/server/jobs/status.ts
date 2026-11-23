import type { Prisma } from "@prisma/client";
import {
  ASSIGNMENT_ENDING_STATUSES,
  JOB_TRANSITIONS,
  REASON_REQUIRED_STATUSES,
  TECHNICIAN_TARGET_STATUSES,
  transitionProblem,
  type JobStatusValue,
} from "@/lib/job-lifecycle";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { recordJobEvent, recordStatusHistory, type TrailActor } from "./events";
import { loadJobAccessFacts, lockJob, jobResourceRef } from "./job-access";
import { notifyJobEmployees } from "./notify";
import { viewJobAfterWrite } from "./read";
import type { TransitionJobInput } from "./schemas";
import { loadDisabledTransitions } from "./settings";

/**
 * The status machine as the service applies it. The rules themselves are `src/lib/job-lifecycle.ts`;
 * this file loads the job's facts, asks the machine, applies the side effects of the new status and
 * writes the trails. Every status change of a job (explicit transition, assignment, scheduling,
 * unassigning) goes through `changeJobStatus`, so none of them can skip a rule.
 */

/** A locked, freshly read job: what every change to status, assignment or schedule starts from. */
export interface JobForChange {
  id: string;
  number: number;
  status: JobStatusValue;
  orgUnitId: string;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  appointmentWindowStart: Date | null;
  appointmentWindowEnd: Date | null;
  estimatedDurationMinutes: number;
  startedAt: Date | null;
  requiresReview: boolean;
}

/**
 * Locks the job row (concurrent dispatchers queue up) and reads it. Archived jobs are read-only.
 * @throws NotFoundError when missing; InvalidStateTransitionError when archived.
 */
export async function loadJobForChange(tx: TenantTx, tenantId: string, jobId: string): Promise<JobForChange> {
  if (!(await lockJob(tx, tenantId, jobId))) throw new NotFoundError();
  const row = await tx.job.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true,
      number: true,
      status: true,
      orgUnitId: true,
      scheduledStartAt: true,
      scheduledEndAt: true,
      appointmentWindowStart: true,
      appointmentWindowEnd: true,
      estimatedDurationMinutes: true,
      startedAt: true,
      archivedAt: true,
      jobType: { select: { requiresReview: true } },
    },
  });
  if (!row) throw new NotFoundError();
  if (row.archivedAt) throw new InvalidStateTransitionError({ message: "An archived job cannot be changed." });
  const { jobType, archivedAt: _archivedAt, ...job } = row;
  return { ...job, requiresReview: jobType.requiresReview };
}

export interface StatusChangeOptions {
  reason?: string | null;
  /** The change is an automatic consequence (no person decided it): the trail records the system as actor. */
  automatic?: boolean;
  /** The caller sets a scheduled slot in this same change, so `SCHEDULED` may be entered although none is stored yet. */
  slotWillBeSet?: boolean;
}

export interface StatusChangeResult {
  from: JobStatusValue;
  to: JobStatusValue;
  /** Employees the job was assigned to just BEFORE the change ended its assignments (empty when it did not). */
  releasedEmployeeIds: string[];
}

/**
 * Moves a job to `to`, or throws `InvalidStateTransitionError` naming why not (no such edge, switched
 * off by the tenant, or a guard: assignment, scheduled slot, review requirement). Also enforces that
 * statuses in `REASON_REQUIRED_STATUSES` carry a reason.
 *
 * Side effects of the new status:
 *  - PENDING_ASSIGNMENT: the active assignments end and the scheduled slot is cleared (nobody is
 *    responsible for a slot any more);
 *  - IN_PROGRESS / COMPLETED / CLOSED / CANCELLED stamp `startedAt` (first time) / `completedAt` / `closedAt` / `cancelledAt`;
 *  - CLOSED and CANCELLED end the assignments, so the work stops granting ASSIGNED access
 *    (customers README contract).
 * Writes `JobStatusHistory`, a `job.status_changed` event and an audit row in the caller's transaction.
 * The caller has already authorized the change and locked the job (`loadJobForChange`).
 */
export async function changeJobStatus(
  tx: TenantTx,
  actor: Actor,
  audit: AuditContextFields,
  job: JobForChange,
  to: JobStatusValue,
  options: StatusChangeOptions = {},
): Promise<StatusChangeResult> {
  const tenantId = actor.tenantId;
  const disabled = await loadDisabledTransitions(tx, tenantId);
  const activeAssignments = await tx.jobAssignment.count({ where: { tenantId, jobId: job.id, state: "ACTIVE" } });
  const problem = transitionProblem(job.status, to, disabled, {
    requiresReview: job.requiresReview,
    hasActiveAssignment: activeAssignments > 0,
    hasScheduledSlot: job.scheduledStartAt !== null || options.slotWillBeSet === true,
  });
  if (problem) throw new InvalidStateTransitionError({ message: problem.message });

  const reason = options.reason?.trim() || null;
  if (REASON_REQUIRED_STATUSES.includes(to) && !reason) {
    throw new ValidationError({ message: `A reason is required to move a job to ${to}.`, field: "reason" });
  }

  const now = new Date();
  const releases = to === "PENDING_ASSIGNMENT" || ASSIGNMENT_ENDING_STATUSES.includes(to);
  const releasedEmployeeIds =
    releases && activeAssignments > 0 ? ((await loadJobAccessFacts(tx, tenantId, [job.id], now)).get(job.id)?.assignedEmployeeIds ?? []) : [];

  const data: Prisma.JobUpdateInput = { status: to, statusChangedAt: now, statusReason: reason };
  if (to === "IN_PROGRESS" && job.startedAt === null) data.startedAt = now;
  if (to === "COMPLETED") data.completedAt = now;
  if (to === "CLOSED") data.closedAt = now;
  if (to === "CANCELLED") data.cancelledAt = now;
  // Status/slot invariant: a job without a responsible assignee, or waiting to be rescheduled, or released from hold
  // (ON_HOLD > ASSIGNED), holds no scheduled slot. SCHEDULED is only entered with a (new) slot.
  if (to === "PENDING_ASSIGNMENT" || to === "RESCHEDULED" || (job.status === "ON_HOLD" && to === "ASSIGNED")) {
    data.scheduledStartAt = null;
    data.scheduledEndAt = null;
  }
  await tx.job.update({ where: { id: job.id }, data });
  if (releases && activeAssignments > 0) {
    await tx.jobAssignment.updateMany({
      where: { tenantId, jobId: job.id, state: "ACTIVE" },
      data: { state: "ENDED", endedAt: now, endedReason: reason ?? `Job moved to ${to}` },
    });
  }

  const trailActor: TrailActor = options.automatic ? null : actor;
  await recordStatusHistory(tx, tenantId, job.id, { from: job.status, to, actor: trailActor, reason });
  await recordJobEvent(tx, tenantId, job.id, { type: "job.status_changed", actor: trailActor, payload: { from: job.status, to } });
  await recordAudit(tx, {
    ...audit,
    action: "job.status_change",
    targetType: "Job",
    targetId: job.id,
    previousValue: { status: job.status },
    newValue: { status: to },
    reason: reason ?? undefined,
  });
  return { from: job.status, to, releasedEmployeeIds };
}

/**
 * Moves a job to another status (`POST /jobs/{id}/transition`). Needs `jobs.edit` over the job, with
 * the field-level check on `status` / `statusReason` (a Technician's execution grant allows them),
 * plus the extra permission some edges carry (review decisions: `jobs.approve` / `jobs.reject`).
 *
 * Execution-only grants (technicians) may only move a job to the statuses in
 * `TECHNICIAN_TARGET_STATUSES` (EN_ROUTE in Phase 2; arrival, start and completion are Phase 3 field
 * events). A move that ends the assignment (back to PENDING_ASSIGNMENT) needs `jobs.assign` too.
 * Cancelling notifies the people the job was assigned to.
 */
export async function transitionJob(actor: Actor, ctx: RequestContext, jobId: string, input: TransitionJobInput): Promise<Record<string, unknown>> {
  const notificationIds: string[] = [];
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.edit");
    // Lock the row BEFORE judging access: the scope attributes (assignees, status) are read after the lock, so a
    // concurrent assignment or status change cannot make this check stale (TOCTOU).
    if (!(await lockJob(tx, actor.tenantId, jobId))) throw new NotFoundError();
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "jobs.edit", ref);
    assertWritableFields(decision, input.reason === undefined ? ["status"] : ["status", "statusReason"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS);

    const job = await loadJobForChange(tx, actor.tenantId, jobId);
    const rule = JOB_TRANSITIONS.find((candidate) => candidate.from === job.status && candidate.to === input.toStatus);
    if (!decision.fieldSets.includes("base") && !TECHNICIAN_TARGET_STATUSES.includes(input.toStatus)) {
      throw new ForbiddenError({ message: `Your access only lets you move a job to: ${TECHNICIAN_TARGET_STATUSES.join(", ")}.` });
    }
    if (rule?.permission) await enforceInTx(tx, actor, rule.permission, ref);
    // Every move that ENDS the assignments (back to the pool, or closing/cancelling the job) takes the job away from its
    // assignees, so it needs the same authority as unassigning: jobs.assign over the job.
    const endsAssignments = input.toStatus === "PENDING_ASSIGNMENT" || ASSIGNMENT_ENDING_STATUSES.includes(input.toStatus);
    if (endsAssignments && (await tx.jobAssignment.count({ where: { tenantId: actor.tenantId, jobId, state: "ACTIVE" } })) > 0) {
      await enforceInTx(tx, actor, "jobs.assign", ref);
    }

    const change = await changeJobStatus(tx, actor, auditContextFields(ctx), job, input.toStatus, { reason: input.reason });
    if (input.toStatus === "CANCELLED") {
      notificationIds.push(...(await notifyJobEmployees(tx, actor, { eventType: "job.cancelled", job, anchor: "cancelled", employeeIds: change.releasedEmployeeIds, link: false })));
    }
    return viewJobAfterWrite(tx, actor, jobId, decision);
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}
