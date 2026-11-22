import type { AssignmentMethod } from "@prisma/client";
import { ASSIGNABLE_STATUSES } from "@/lib/job-lifecycle";
import type { EligibilityFailure } from "@/lib/eligibility";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx, enforceInTx } from "@/server/authz";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  type Actor,
  type FieldIssue,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { evaluateCandidates, isEligible, orgUnitAncestry, requirementsFromInputs } from "@/server/qualifications";
import { getJobEligibilityInputs } from "./eligibility-inputs";
import { recordJobEvent } from "./events";
import { jobResourceRef, loadJobAccessFacts, teamMembers } from "./job-access";
import { notifyJobEmployees } from "./notify";
import { viewJobAfterWrite } from "./read";
import type { AssignJobInput, UnassignJobInput } from "./schemas";
import { changeJobStatus, loadJobForChange, type JobForChange } from "./status";

/**
 * Manual assignment, reassignment and unassignment (§7.1, §7.3, §25.2). Dispatch RECOMMENDATIONS are a
 * later task; here a person chooses, and the choice is recorded with method MANUAL (or OVERRIDE).
 *
 * HARD ELIGIBILITY IS ENFORCED, not advised (§7.3): an employee who is inactive, lacks a required skill
 * or credential, is outside the service territory, has no job-category permission or is not available
 * for the whole appointment cannot be assigned. The single way past it is an explicit override with a
 * reason by someone who holds `jobs.approve` over the job (Owner and COO in the default templates; a
 * tenant may grant it to a senior dispatcher through a custom role). Why `jobs.approve`: it is the
 * catalog's existing "approve an exception on a job" permission, it is not part of the Dispatcher
 * template (so the person who makes the assignment is not the person who excuses a safety or license
 * rule), and it needs no new permission. Employment failures (terminated, on leave) can never be overridden.
 * An override is stored on the assignment (method OVERRIDE + reason), as a `dispatch.override` job event
 * and in the audit log.
 */

const NOT_OVERRIDABLE: ReadonlyArray<EligibilityFailure["code"]> = ["EMPLOYEE_NOT_ACTIVE", "EMPLOYEE_NOT_EMPLOYED"];

type Target = { employeeId: string } | { teamOrgUnitId: string };

const failureIssues = (field: string, failures: EligibilityFailure[]): FieldIssue[] => {
  const seen = new Set<string>();
  return failures.flatMap((failure) => {
    if (seen.has(failure.code)) return [];
    seen.add(failure.code);
    return [{ field, code: failure.code, message: `Not eligible: ${failure.code}` }];
  });
};

/** The span the employee must be able to work: the scheduled slot if there is one, else the appointment window. */
function workWindow(job: JobForChange): { startsAt: Date; endsAt: Date } | null {
  if (job.scheduledStartAt && job.scheduledEndAt) return { startsAt: job.scheduledStartAt, endsAt: job.scheduledEndAt };
  if (job.appointmentWindowStart && job.appointmentWindowEnd) return { startsAt: job.appointmentWindowStart, endsAt: job.appointmentWindowEnd };
  return null;
}

/**
 * Judges the target with the qualification engine. A team is eligible when at least one current
 * member is (the team lead then allocates inside the team; each member is still checked on their own
 * if the job is later assigned to them).
 */
async function eligibilityFailures(tx: TenantTx, actor: Actor, job: JobForChange, target: Target): Promise<EligibilityFailure[]> {
  const tenantId = actor.tenantId;
  const { requirements, timeZone } = await requirementsFromInputs(tx, tenantId, await getJobEligibilityInputs(tx, tenantId, job.id));
  const query = { at: new Date(), window: workWindow(job), timeZone };

  if ("employeeId" in target) {
    return (await isEligible(tx, tenantId, target.employeeId, requirements, query)).failures;
  }
  const members = (await teamMembers(tx, tenantId, [target.teamOrgUnitId])).get(target.teamOrgUnitId) ?? [];
  if (members.length === 0) return [{ code: "EMPLOYEE_NOT_ACTIVE", params: { reason: "TEAM_HAS_NO_ACTIVE_MEMBERS" } }];
  const verdicts = await evaluateCandidates(tx, tenantId, members, requirements, query);
  const results = [...verdicts.values()];
  if (results.some((verdict) => verdict.eligible)) return [];
  return results.flatMap((verdict) => verdict.failures);
}

/** Validates that the target exists and may be assigned this job at all (employee exists; team is an active TEAM inside the service area). */
async function validateTarget(tx: TenantTx, tenantId: string, job: JobForChange, input: AssignJobInput): Promise<Target> {
  if (input.employeeId) {
    const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId }, select: { id: true } });
    if (!employee) throw new ValidationError({ message: "Unknown employee.", field: "employeeId" });
    return { employeeId: employee.id };
  }
  const teamOrgUnitId = input.teamOrgUnitId as string;
  const team = await tx.orgUnit.findFirst({ where: { id: teamOrgUnitId, tenantId, type: "TEAM", active: true }, select: { id: true } });
  if (!team) throw new ValidationError({ message: "Unknown or archived team.", field: "teamOrgUnitId" });
  // A team can take work of its own area, or of an area above it (a city job handed to one of the city's teams).
  if (team.id !== job.orgUnitId && !(await orgUnitAncestry(tx, tenantId, team.id)).includes(job.orgUnitId)) {
    throw new ValidationError({ message: "The team is outside the job's service area.", field: "teamOrgUnitId" });
  }
  return { teamOrgUnitId: team.id };
}

/**
 * Gives a job to ONE employee or ONE team, replacing the current assignment (reassignment). Needs
 * `jobs.assign` over the job, with the base field set (a field-limited grant cannot assign).
 *
 * Statuses that allow it: `ASSIGNABLE_STATUSES` (not once the technician is on the way: that is
 * Phase 3 territory). A PENDING_ASSIGNMENT job becomes ASSIGNED; any other keeps its status (a
 * SCHEDULED job reassigned stays SCHEDULED). The previous assignment is ENDED, never deleted. Hard
 * eligibility is enforced (see the file comment); an `override` is honoured only for `jobs.approve`
 * holders. The new assignee is notified (`job.assigned`), the one who lost the job too
 * (`job.reassigned`), both after commit.
 */
export async function assignJob(actor: Actor, ctx: RequestContext, jobId: string, input: AssignJobInput): Promise<Record<string, unknown>> {
  const notificationIds: string[] = [];
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.assign");
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "jobs.assign", ref);
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    const job = await loadJobForChange(tx, actor.tenantId, jobId);
    if (!ASSIGNABLE_STATUSES.includes(job.status)) {
      throw new InvalidStateTransitionError({ message: `A job in status ${job.status} can no longer be assigned or reassigned.` });
    }
    const target = await validateTarget(tx, actor.tenantId, job, input);

    const current = await tx.jobAssignment.findMany({
      where: { tenantId: actor.tenantId, jobId, state: "ACTIVE" },
      select: { id: true, employeeId: true, teamOrgUnitId: true },
    });
    const alreadyAssigned = current.some((row) => ("employeeId" in target ? row.employeeId === target.employeeId : row.teamOrgUnitId === target.teamOrgUnitId));
    if (alreadyAssigned) throw new ConflictError({ message: "The job is already assigned to this employee or team." });

    let method: AssignmentMethod = "MANUAL";
    const failures = await eligibilityFailures(tx, actor, job, target);
    if (failures.length > 0) {
      const field = "employeeId" in target ? "employeeId" : "teamOrgUnitId";
      if (!input.override) {
        throw new ConflictError({
          message: "The assignee is not eligible for this job. Fix the reasons below or ask someone with approval rights to override.",
          field,
          details: failureIssues(field, failures),
        });
      }
      if (failures.some((failure) => NOT_OVERRIDABLE.includes(failure.code))) {
        throw new ConflictError({ message: "An inactive or terminated employee cannot be assigned, even with an override.", field, details: failureIssues(field, failures) });
      }
      if (!(await canInTx(tx, actor, "jobs.approve", ref)).allowed) {
        throw new ForbiddenError({ message: "Assigning an ineligible employee needs approval rights (jobs.approve)." });
      }
      method = "OVERRIDE";
    }

    const now = new Date();
    const before = (await loadJobAccessFacts(tx, actor.tenantId, [jobId], now)).get(jobId)?.assignedEmployeeIds ?? [];
    if (current.length > 0) {
      await tx.jobAssignment.updateMany({
        where: { tenantId: actor.tenantId, jobId, state: "ACTIVE" },
        data: { state: "ENDED", endedAt: now, endedReason: input.reason ?? "Reassigned" },
      });
    }
    const assignment = await tx.jobAssignment.create({
      data: {
        tenantId: actor.tenantId,
        jobId,
        employeeId: "employeeId" in target ? target.employeeId : null,
        teamOrgUnitId: "teamOrgUnitId" in target ? target.teamOrgUnitId : null,
        role: "LEAD",
        method,
        overrideReason: method === "OVERRIDE" ? (input.override?.reason ?? null) : null,
        assignedById: actor.userId,
        reason: input.reason ?? null,
        assignedAt: now,
      },
      select: { id: true },
    });
    const audit = auditContextFields(ctx);
    if (job.status === "PENDING_ASSIGNMENT") await changeJobStatus(tx, actor, audit, job, "ASSIGNED", { reason: input.reason });

    const isReassignment = current.length > 0;
    const payload = { assignmentId: assignment.id, ...target, method, previousAssignmentIds: current.map((row) => row.id) };
    await recordJobEvent(tx, actor.tenantId, jobId, { type: isReassignment ? "job.reassigned" : "job.assigned", actor, payload });
    if (method === "OVERRIDE") {
      // §7.4: a manual override must be recorded, with who decided it and why.
      await recordJobEvent(tx, actor.tenantId, jobId, {
        type: "dispatch.override",
        actor,
        payload: { assignmentId: assignment.id, ...target, reason: input.override?.reason ?? null, failureCodes: [...new Set(failures.map((failure) => failure.code))] },
      });
    }
    await recordAudit(tx, {
      ...audit,
      action: isReassignment ? "job.reassign" : "job.assign",
      targetType: "Job",
      targetId: jobId,
      previousValue: { assignments: current.map(({ employeeId, teamOrgUnitId }) => ({ employeeId, teamOrgUnitId })) },
      newValue: { ...target, method },
      reason: method === "OVERRIDE" ? (input.override?.reason ?? input.reason) : input.reason,
    });

    const after = (await loadJobAccessFacts(tx, actor.tenantId, [jobId], now)).get(jobId)?.assignedEmployeeIds ?? [];
    notificationIds.push(
      ...(await notifyJobEmployees(tx, actor, { eventType: "job.assigned", job, anchor: `assigned:${assignment.id}`, employeeIds: after, link: true })),
      ...(await notifyJobEmployees(tx, actor, {
        eventType: "job.reassigned",
        job,
        anchor: `reassigned:${assignment.id}`,
        employeeIds: before.filter((employeeId) => !after.includes(employeeId)),
        link: false,
      })),
    );
    return viewJobAfterWrite(tx, actor, jobId, decision);
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}

/**
 * Takes the job off whoever has it: the assignments end, the scheduled slot is cleared and the job goes
 * back to PENDING_ASSIGNMENT (so it must be an allowed transition for the tenant). Needs `jobs.assign`
 * over the job; the reason is required and kept. The people who lost the job are notified.
 */
export async function unassignJob(actor: Actor, ctx: RequestContext, jobId: string, input: UnassignJobInput): Promise<Record<string, unknown>> {
  const notificationIds: string[] = [];
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.assign");
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "jobs.assign", ref);
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    const job = await loadJobForChange(tx, actor.tenantId, jobId);
    if (!ASSIGNABLE_STATUSES.includes(job.status)) {
      throw new InvalidStateTransitionError({ message: `A job in status ${job.status} can no longer be unassigned.` });
    }
    const current = await tx.jobAssignment.findMany({
      where: { tenantId: actor.tenantId, jobId, state: "ACTIVE" },
      select: { employeeId: true, teamOrgUnitId: true },
    });
    if (current.length === 0) throw new InvalidStateTransitionError({ message: "The job has no assignment to remove." });

    const audit = auditContextFields(ctx);
    const change = await changeJobStatus(tx, actor, audit, job, "PENDING_ASSIGNMENT", { reason: input.reason });
    const eventId = await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.unassigned", actor, payload: { assignments: current } });
    await recordAudit(tx, { ...audit, action: "job.unassign", targetType: "Job", targetId: jobId, previousValue: { assignments: current }, reason: input.reason });
    notificationIds.push(
      ...(await notifyJobEmployees(tx, actor, { eventType: "job.reassigned", job, anchor: `unassigned:${eventId}`, employeeIds: change.releasedEmployeeIds, link: false })),
    );
    return viewJobAfterWrite(tx, actor, jobId, decision);
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}
