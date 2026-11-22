import { enforceInTx } from "@/server/authz";
import { ForbiddenError, NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobResourceRef } from "./job-access";
import type { ListHistoryQuery } from "./schemas";

/**
 * The job's trails, read-only (§7.2, §21): status history, the event log and the assignment history.
 * Each needs `jobs.view` over the job WITH the base field set: a financial-only grant (Finance) sees
 * money on a job, not who did what to it. Newest first, paged.
 */

async function assertMayReadTrail(actor: Actor, jobId: string, tx: Parameters<typeof jobResourceRef>[0]): Promise<void> {
  await enforceInTx(tx, actor, "jobs.view");
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, "jobs.view", ref);
  if (!decision.fieldSets.includes("base")) throw new ForbiddenError();
}

/** Status changes of the job: previous, new, actor (null = the system), reason, time. */
export async function listJobStatusHistory(actor: Actor, jobId: string, query: ListHistoryQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertMayReadTrail(actor, jobId, tx);
    const rows = await tx.jobStatusHistory.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: { id: true, fromStatus: true, toStatus: true, actorType: true, actorUserId: true, reason: true, occurredAt: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/** Everything that happened to the job (`type` is a dotted key such as `job.assigned`; clients translate `JOB.EVENT.<type>`). */
export async function listJobEvents(actor: Actor, jobId: string, query: ListHistoryQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertMayReadTrail(actor, jobId, tx);
    const rows = await tx.jobEvent.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: { id: true, type: true, actorType: true, actorUserId: true, occurredAt: true, recordedAt: true, payload: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/** Every assignment the job has had, current first: who or which team, how (MANUAL / OVERRIDE...), by whom, and when it ended. */
export async function listJobAssignments(actor: Actor, jobId: string, query: ListHistoryQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertMayReadTrail(actor, jobId, tx);
    const rows = await tx.jobAssignment.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: {
        id: true,
        employeeId: true,
        teamOrgUnitId: true,
        role: true,
        state: true,
        method: true,
        overrideReason: true,
        assignedAt: true,
        assignedById: true,
        reason: true,
        endedAt: true,
        endedReason: true,
      },
      orderBy: [{ state: "asc" }, { assignedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}
