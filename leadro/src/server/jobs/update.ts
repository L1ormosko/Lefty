import { changedFields } from "@/lib/changed-fields";
import { appointmentWarnings, isTerminalJobStatus, type JobStatusValue } from "@/lib/job-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { recordJobEvent } from "./events";
import { jobResourceRef, lockJob } from "./job-access";
import { viewJobAfterWrite } from "./read";
import type { UpdateJobInput } from "./schemas";

/**
 * Edits the facts of a job (title, description, instructions, priority, estimated duration, time
 * zone, quoted amount). Status, assignment and schedule have their own operations.
 *
 * Needs `jobs.edit` over the job AND, for every field SENT, the right to write it
 * (`assertWritableFields`): a Technician's execution grant covers `instructions` only; money needs the
 * `financial` grant; everything else the plain grant. Closed and cancelled jobs are read-only.
 * Audited with the changed fields; money values are recorded by field name only (audit readers need
 * not hold the financial grant). A priority change also leaves a `job.priority_changed` event.
 */
export async function updateJob(actor: Actor, ctx: RequestContext, jobId: string, input: UpdateJobInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.edit");
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "jobs.edit", ref);
    const sent = Object.entries(input).filter(([, value]) => value !== undefined).map(([key]) => key);
    assertWritableFields(decision, sent, JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS);

    if (!(await lockJob(tx, actor.tenantId, jobId))) throw new NotFoundError();
    const current = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: {
        title: true,
        description: true,
        instructions: true,
        priority: true,
        estimatedDurationMinutes: true,
        timeZone: true,
        quotedAmountMinor: true,
        currency: true,
        status: true,
        archivedAt: true,
        appointmentWindowStart: true,
        appointmentWindowEnd: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
      },
    });
    if (!current) throw new NotFoundError();
    if (current.archivedAt || isTerminalJobStatus(current.status as JobStatusValue)) {
      throw new InvalidStateTransitionError({ message: "A closed, cancelled or archived job cannot be edited." });
    }

    const { changedKeys, previous, next } = changedFields(current, input);
    const warningsFor = (estimatedDurationMinutes: number) =>
      appointmentWarnings({
        estimatedDurationMinutes,
        window: current.appointmentWindowStart && current.appointmentWindowEnd ? { start: current.appointmentWindowStart, end: current.appointmentWindowEnd } : null,
        slot: current.scheduledStartAt && current.scheduledEndAt ? { start: current.scheduledStartAt, end: current.scheduledEndAt } : null,
      });
    if (changedKeys.length === 0) return viewJobAfterWrite(tx, actor, jobId, decision, { warnings: warningsFor(current.estimatedDurationMinutes) });

    await tx.job.update({ where: { id: jobId }, data: input });

    const money = changedKeys.filter((key) => key === "quotedAmountMinor" || key === "currency");
    const safe = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => !money.includes(key as never)));
    await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.updated", actor, payload: { changedFields: changedKeys } });
    if (changedKeys.includes("priority")) {
      await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.priority_changed", actor, payload: { from: current.priority, to: input.priority ?? null } });
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job.update",
      targetType: "Job",
      targetId: jobId,
      previousValue: money.length > 0 ? { ...safe(previous), financialFieldsChanged: money } : previous,
      newValue: money.length > 0 ? { ...safe(next), financialFieldsChanged: money } : next,
    });
    return viewJobAfterWrite(tx, actor, jobId, decision, { warnings: warningsFor(input.estimatedDurationMinutes ?? current.estimatedDurationMinutes) });
  });
}
