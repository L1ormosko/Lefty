import { hashFieldEventContent } from "@/lib/location-rules";
import { auditContextFields } from "@/server/audit";
import { JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { changeJobStatus, loadJobForChange } from "@/server/jobs";
import { assignedJobRef, eventTime, requireEmployee, runOwnFieldWrite, type EmployeeActor } from "./own-field-write";
import type { StartWorkInput } from "./schemas";

/**
 * "Start work" (§8.1): ARRIVED > IN_PROGRESS through the jobs lifecycle, stamping `Job.startedAt` the first time.
 * Needs `jobs.edit` over the job with `status` writable (a Technician's execution grant) and a job assigned to the caller
 * (else 404). Work cannot start while the latest arrival was rejected by a manager. Offline-safe: with `occurredAt`
 * the work starts at the device time (never before the arrival it follows); a replay answers from the first delivery.
 */

export interface StartWorkResult {
  job: { id: string; status: string; startedAt: Date | null };
}

async function viewJob(tx: TenantTx, tenantId: string, jobId: string): Promise<StartWorkResult> {
  const job = await tx.job.findFirst({ where: { id: jobId, tenantId }, select: { id: true, status: true, startedAt: true } });
  if (!job) throw new NotFoundError();
  return { job };
}

export async function startWork(actor: Actor, ctx: RequestContext, jobId: string, input: StartWorkInput): Promise<StartWorkResult & { replayed: boolean }> {
  const self: EmployeeActor = requireEmployee(actor);
  const now = new Date();
  const startedAt = eventTime(input.occurredAt, now);

  const apply = async (tx: TenantTx) => {
    const job = await loadJobForChange(tx, actor.tenantId, jobId); // locks the row
    const ref = await assignedJobRef(tx, self, jobId);
    const decision = await enforceInTx(tx, self, "jobs.edit", ref);
    assertWritableFields(decision, ["status"], JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS);
    if (job.status !== "ARRIVED") {
      throw new InvalidStateTransitionError({ message: `Work can only start after arrival (the job is ${job.status}).` });
    }
    const latest = await tx.arrivalVerification.findFirst({ where: { tenantId: actor.tenantId, jobId, employeeId: self.employeeId }, orderBy: [{ arrivedAt: "desc" }, { id: "desc" }], select: { status: true, arrivedAt: true } });
    if (latest?.status === "MANAGER_REJECTED") {
      throw new InvalidStateTransitionError({ message: "A manager rejected your arrival. Ask them to review it before starting work." });
    }
    await changeJobStatus(tx, actor, auditContextFields(ctx), job, "IN_PROGRESS");
    if (job.startedAt === null) {
      // The work started when the device says it did, but never before the arrival it follows.
      const effective = latest && latest.arrivedAt > startedAt ? latest.arrivedAt : startedAt;
      await tx.job.update({ where: { id: jobId }, data: { startedAt: effective } });
    }
    return { result: await viewJob(tx, actor.tenantId, jobId), entity: { type: "Job", id: jobId } };
  };

  const outcome = await runOwnFieldWrite<StartWorkResult>({
    actor: self,
    jobId,
    type: "job.start_work",
    clientEventId: input.clientEventId,
    occurredAt: startedAt,
    deviceId: input.deviceId,
    payloadHash: hashFieldEventContent({ type: "job.start_work", jobId, occurredAt: input.occurredAt }),
    apply,
    replay: (tx) => viewJob(tx, actor.tenantId, jobId),
  });
  return { ...outcome.result, replayed: outcome.replayed };
}
