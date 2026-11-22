import { RESCHEDULABLE_STATUSES, appointmentWarnings, type JobWarning } from "@/lib/job-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { isEligible, requirementsFromInputs } from "@/server/qualifications";
import { getJobEligibilityInputs } from "./eligibility-inputs";
import { recordJobEvent } from "./events";
import { jobResourceRef, loadJobAccessFacts } from "./job-access";
import { notifyJobEmployees } from "./notify";
import { viewJobAfterWrite } from "./read";
import type { RescheduleJobInput } from "./schemas";
import { changeJobStatus, loadJobForChange, type JobForChange } from "./status";

/**
 * Rescheduling (§7.1 appointment window, §25.2 scheduling conflicts). Two spans can change:
 *  - the customer-facing APPOINTMENT WINDOW (arrival window), any time while the job is open;
 *  - the dispatcher's SCHEDULED SLOT, which needs somebody assigned to it. Setting a slot on an
 *    ASSIGNED, RESCHEDULED, CUSTOMER_UNAVAILABLE or REQUIRES_RETURN_VISIT job also moves it to SCHEDULED.
 *
 * Conflicts are shown, never blocking (§25.2 "display the conflict, preserve the job"): the response
 * carries `warnings` for a duration longer than the window or slot and for an assigned employee who is
 * not eligible/available for the new time, so the dispatcher can resolve it (reassign, move again).
 */

const STATUSES_THAT_BECOME_SCHEDULED = ["ASSIGNED", "RESCHEDULED", "CUSTOMER_UNAVAILABLE", "REQUIRES_RETURN_VISIT"];

const sameInstant = (a: Date | null, b: Date | null): boolean => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/** Warnings for the assigned EMPLOYEES (teams vary by member) against the new work span. */
async function assigneeConflicts(tx: TenantTx, actor: Actor, job: JobForChange, slot: { start: Date; end: Date } | null, window: { start: Date; end: Date } | null): Promise<JobWarning[]> {
  const span = slot ?? window;
  if (!span) return [];
  const employees = await tx.jobAssignment.findMany({
    where: { tenantId: actor.tenantId, jobId: job.id, state: "ACTIVE", employeeId: { not: null } },
    select: { employeeId: true },
  });
  if (employees.length === 0) return [];
  const { requirements, timeZone } = await requirementsFromInputs(tx, actor.tenantId, await getJobEligibilityInputs(tx, actor.tenantId, job.id));
  const warnings: JobWarning[] = [];
  for (const { employeeId } of employees) {
    if (!employeeId) continue;
    const verdict = await isEligible(tx, actor.tenantId, employeeId, requirements, { at: new Date(), window: { startsAt: span.start, endsAt: span.end }, timeZone });
    if (!verdict.eligible) {
      warnings.push({ code: "ASSIGNEE_ELIGIBILITY_CONFLICT", params: { employeeId, failureCodes: [...new Set(verdict.failures.map((failure) => failure.code))].join(",") } });
    }
  }
  return warnings;
}

/**
 * Changes the appointment window and/or the scheduled slot (`null` clears; the slot cannot be cleared
 * while the job is SCHEDULED: unassign or change its status instead). Needs `jobs.edit` over the job
 * with the scheduling fields writable (a Technician's execution grant does not include them). The
 * assignees are notified (`job.rescheduled`) after commit. A request that changes nothing writes nothing.
 */
export async function rescheduleJob(actor: Actor, ctx: RequestContext, jobId: string, input: RescheduleJobInput): Promise<Record<string, unknown>> {
  const notificationIds: string[] = [];
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.edit");
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "jobs.edit", ref);
    const sent = [
      ...(input.appointmentWindow !== undefined ? ["appointmentWindowStart", "appointmentWindowEnd"] : []),
      ...(input.scheduledSlot !== undefined ? ["scheduledStartAt", "scheduledEndAt"] : []),
    ];
    assertWritableFields(decision, sent, JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS);

    const job = await loadJobForChange(tx, actor.tenantId, jobId);
    if (!RESCHEDULABLE_STATUSES.includes(job.status)) {
      throw new InvalidStateTransitionError({ message: `A job in status ${job.status} cannot be rescheduled.` });
    }

    const currentWindow = job.appointmentWindowStart && job.appointmentWindowEnd ? { start: job.appointmentWindowStart, end: job.appointmentWindowEnd } : null;
    const currentSlot = job.scheduledStartAt && job.scheduledEndAt ? { start: job.scheduledStartAt, end: job.scheduledEndAt } : null;
    const window = input.appointmentWindow === undefined ? currentWindow : input.appointmentWindow;
    const slot = input.scheduledSlot === undefined ? currentSlot : input.scheduledSlot;

    if (input.scheduledSlot && (await tx.jobAssignment.count({ where: { tenantId: actor.tenantId, jobId, state: "ACTIVE" } })) === 0) {
      throw new ValidationError({ message: "Assign the job before giving it a scheduled time.", field: "scheduledSlot" });
    }
    if (input.scheduledSlot === null && job.status === "SCHEDULED") {
      throw new InvalidStateTransitionError({ message: "A scheduled job needs its time: unassign it or change its status instead of clearing the slot." });
    }

    const changed = !sameInstant(job.appointmentWindowStart, window?.start ?? null) || !sameInstant(job.appointmentWindowEnd, window?.end ?? null) ||
      !sameInstant(job.scheduledStartAt, slot?.start ?? null) || !sameInstant(job.scheduledEndAt, slot?.end ?? null);
    const warnings = [
      ...appointmentWarnings({ estimatedDurationMinutes: job.estimatedDurationMinutes, window, slot }),
      ...(await assigneeConflicts(tx, actor, job, slot, window)),
    ];
    if (!changed) return viewJobAfterWrite(tx, actor, jobId, decision, { warnings });

    await tx.job.update({
      where: { id: jobId },
      data: {
        appointmentWindowStart: window?.start ?? null,
        appointmentWindowEnd: window?.end ?? null,
        scheduledStartAt: slot?.start ?? null,
        scheduledEndAt: slot?.end ?? null,
      },
    });
    const audit = auditContextFields(ctx);
    if (input.scheduledSlot && STATUSES_THAT_BECOME_SCHEDULED.includes(job.status)) {
      await changeJobStatus(tx, actor, audit, { ...job, scheduledStartAt: slot?.start ?? null, scheduledEndAt: slot?.end ?? null }, "SCHEDULED", { reason: input.reason, slotWillBeSet: true });
    }

    const spans = (w: typeof window, s: typeof slot) => ({
      appointmentWindowStart: w?.start.toISOString() ?? null,
      appointmentWindowEnd: w?.end.toISOString() ?? null,
      scheduledStartAt: s?.start.toISOString() ?? null,
      scheduledEndAt: s?.end.toISOString() ?? null,
    });
    const previous = spans(currentWindow, currentSlot);
    const next = spans(window, slot);
    const eventId = await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.rescheduled", actor, payload: { previous, next, reason: input.reason ?? null } });
    await recordAudit(tx, { ...audit, action: "job.reschedule", targetType: "Job", targetId: jobId, previousValue: previous, newValue: next, reason: input.reason });

    const assignees = (await loadJobAccessFacts(tx, actor.tenantId, [jobId])).get(jobId)?.assignedEmployeeIds ?? [];
    notificationIds.push(...(await notifyJobEmployees(tx, actor, { eventType: "job.rescheduled", job, anchor: `rescheduled:${eventId}`, employeeIds: assignees, link: true })));
    return viewJobAfterWrite(tx, actor, jobId, decision, { warnings });
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}
