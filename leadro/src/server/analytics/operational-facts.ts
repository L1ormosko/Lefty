import type { Prisma } from "@prisma/client";
import type { KpiFact } from "@/lib/kpi-aggregation";
import { attributeVisit } from "@/lib/performance-formulas";
import { placementAt } from "@/lib/kpi-aggregation";
import { MAX_SOURCE_ROWS, assertWithinRowCap, inChunks, rangeOf, type KpiComputeContext, type KpiFactLoader } from "./compute-context";

/**
 * Fact loaders of the operational KPIs (spec 13.2) and job volume (13.1). Each reads only through `context.tx` (the read-only
 * reporting transaction) and selects its records with `context.where` (viewer scope + requested unit, via `withinScope`).
 * Formulas and anchors are the catalog's (`src/lib/kpi-catalog.ts`); a change here must change the catalog text too.
 */

const take = MAX_SOURCE_ROWS + 1;
const jobSelect = { id: true, orgUnitId: true, createdAt: true } as const;

/** Jobs created in the range (the cohort of the COHORT_IN_PERIOD job KPIs). */
async function jobsCreatedInRange<S extends Prisma.JobSelect>(context: KpiComputeContext, select: S, extra: Prisma.JobWhereInput = {}) {
  return assertWithinRowCap(
    await context.tx.job.findMany({
      where: context.where<Prisma.JobWhereInput>({ tenantId: context.tenantId, createdAt: rangeOf(context), ...extra }),
      select,
      orderBy: { id: "asc" },
      take,
    }),
  );
}

/** Jobs completed in the range. */
async function jobsCompletedInRange<S extends Prisma.JobSelect>(context: KpiComputeContext, select: S, extra: Prisma.JobWhereInput = {}) {
  return assertWithinRowCap(
    await context.tx.job.findMany({
      where: context.where<Prisma.JobWhereInput>({ tenantId: context.tenantId, completedAt: rangeOf(context), ...extra }),
      select,
      orderBy: { id: "asc" },
      take,
    }),
  );
}

/** First LEAD assignment (any state, so later reassignments do not hide it) per job: its time and method. */
async function firstLeadAssignments(context: KpiComputeContext, jobIds: string[]) {
  const rows = await inChunks(jobIds, (chunk) =>
    context.tx.jobAssignment.findMany({
      where: { tenantId: context.tenantId, jobId: { in: chunk }, role: "LEAD" },
      select: { jobId: true, assignedAt: true, method: true, id: true },
      orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
    }),
  );
  const first = new Map<string, { assignedAt: Date; method: string }>();
  for (const row of rows) if (!first.has(row.jobId)) first.set(row.jobId, row);
  return first;
}

const duration = (from: Date, to: Date) => to.getTime() - from.getTime();

const jobVolume: KpiFactLoader = async (context) =>
  (await jobsCreatedInRange(context, jobSelect)).map((job) => ({ recordId: job.id, at: job.createdAt, orgUnitId: job.orgUnitId }));

const completedJobs: KpiFactLoader = async (context) =>
  (await jobsCompletedInRange(context, { id: true, orgUnitId: true, completedAt: true })).map((job) => ({
    recordId: job.id,
    at: job.completedAt as Date, // selected by a completedAt range, so never null
    orgUnitId: job.orgUnitId,
  }));

const jobDuration: KpiFactLoader = async (context) =>
  (await jobsCompletedInRange(context, { id: true, orgUnitId: true, completedAt: true, startedAt: true }, { startedAt: { not: null } })).flatMap((job) => {
    const completedAt = job.completedAt as Date;
    const ms = job.startedAt ? duration(job.startedAt, completedAt) : -1;
    return ms >= 0 ? [{ recordId: job.id, at: completedAt, orgUnitId: job.orgUnitId, durationMs: ms }] : [];
  });

const revisitRate: KpiFactLoader = async (context) =>
  (await jobsCreatedInRange(context, { ...jobSelect, currentVisitNumber: true }, { completedAt: { not: null } })).map((job) => ({
    recordId: job.id,
    at: job.createdAt,
    orgUnitId: job.orgUnitId,
    hit: job.currentVisitNumber > 1,
  }));

const cancellationRate: KpiFactLoader = async (context) =>
  (await jobsCreatedInRange(context, { ...jobSelect, status: true })).map((job) => ({
    recordId: job.id,
    at: job.createdAt,
    orgUnitId: job.orgUnitId,
    hit: job.status === "CANCELLED",
  }));

const timeToAssignment: KpiFactLoader = async (context) => {
  const jobs = await jobsCreatedInRange(context, jobSelect);
  const first = await firstLeadAssignments(context, jobs.map((job) => job.id));
  return jobs.flatMap((job) => {
    const assignment = first.get(job.id);
    const ms = assignment ? duration(job.createdAt, assignment.assignedAt) : -1;
    return ms >= 0 ? [{ recordId: job.id, at: job.createdAt, orgUnitId: job.orgUnitId, durationMs: ms }] : [];
  });
};

const timeToArrival: KpiFactLoader = async (context) => {
  const jobs = await jobsCreatedInRange(context, jobSelect);
  const ids = jobs.map((job) => job.id);
  const first = await firstLeadAssignments(context, ids);
  const arrivals = await inChunks(ids, (chunk) =>
    context.tx.arrivalVerification.groupBy({
      by: ["jobId"],
      // A rejected arrival is a claim a manager refused (spec 8.4): it is not an arrival.
      where: { tenantId: context.tenantId, jobId: { in: chunk }, status: { not: "MANAGER_REJECTED" } },
      _min: { arrivedAt: true },
    }),
  );
  const arrivedAt = new Map(arrivals.map((row) => [row.jobId, row._min.arrivedAt]));
  return jobs.flatMap((job) => {
    const assignment = first.get(job.id);
    const arrival = arrivedAt.get(job.id);
    const ms = assignment && arrival ? duration(assignment.assignedAt, arrival) : -1;
    return ms >= 0 ? [{ recordId: job.id, at: job.createdAt, orgUnitId: job.orgUnitId, durationMs: ms }] : [];
  });
};

const acceptanceRate: KpiFactLoader = async (context) => {
  const jobs = await jobsCreatedInRange(context, jobSelect);
  const first = await firstLeadAssignments(context, jobs.map((job) => job.id));
  return jobs.flatMap((job) => {
    const assignment = first.get(job.id);
    return assignment ? [{ recordId: job.id, at: job.createdAt, orgUnitId: job.orgUnitId, hit: assignment.method === "RECOMMENDATION_APPROVED" }] : [];
  });
};

const decisionLatency: KpiFactLoader = async (context) => {
  const jobs = await jobsCreatedInRange(context, jobSelect);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const recommendations = assertWithinRowCap(
    await inChunks([...byId.keys()], (chunk) =>
      context.tx.dispatchRecommendation.findMany({
        where: { tenantId: context.tenantId, jobId: { in: chunk }, decidedAt: { not: null } },
        select: { id: true, jobId: true, generatedAt: true, decidedAt: true },
      }),
    ),
  );
  return recommendations.flatMap((recommendation) => {
    const job = byId.get(recommendation.jobId);
    const ms = job && recommendation.decidedAt ? duration(recommendation.generatedAt, recommendation.decidedAt) : -1;
    return job && ms >= 0 ? [{ recordId: recommendation.id, at: job.createdAt, orgUnitId: job.orgUnitId, durationMs: ms }] : [];
  });
};

/** Jobs that wait for a lead technician right now. */
const unassignedJobs: KpiFactLoader = async (context) =>
  assertWithinRowCap(
    await context.tx.job.findMany({
      where: context.where<Prisma.JobWhereInput>({
        tenantId: context.tenantId,
        archivedAt: null,
        status: { in: ["CREATED", "PENDING_ASSIGNMENT", "RESCHEDULED"] },
        assignments: { none: { role: "LEAD", state: "ACTIVE" } },
      }),
      select: { id: true, orgUnitId: true },
      orderBy: { id: "asc" },
      take,
    }),
  ).map((job) => ({ recordId: job.id, at: context.now, orgUnitId: job.orgUnitId }));

/**
 * Completed jobs per lead technician, grouped by the technician's PRIMARY placement effective at completion (spec 3). The job
 * must be in the viewer's scope, and so must the unit the technician belonged to then: otherwise the job is left out, so no
 * figure is ever attributed to a unit the viewer cannot see. Facts carry the employee only as the ratio's contributor; the
 * engine never returns them per employee.
 */
const jobsPerEmployee: KpiFactLoader = async (context) => {
  const jobs = await jobsCompletedInRange(context, { id: true, completedAt: true });
  const ids = jobs.map((job) => job.id);
  const assignments = await inChunks(ids, (chunk) =>
    context.tx.jobAssignment.findMany({
      where: { tenantId: context.tenantId, jobId: { in: chunk }, role: "LEAD", employeeId: { not: null } },
      select: { jobId: true, employeeId: true, assignedAt: true, endedAt: true },
    }),
  );
  const byJob = new Map<string, Array<{ employeeId: string; assignedAt: Date; endedAt: Date | null }>>();
  for (const row of assignments) {
    const list = byJob.get(row.jobId) ?? [];
    list.push({ employeeId: row.employeeId as string, assignedAt: row.assignedAt, endedAt: row.endedAt });
    byJob.set(row.jobId, list);
  }
  const led = jobs.flatMap((job) => {
    const employeeId = attributeVisit({ completedAt: job.completedAt as Date, leadAssignments: byJob.get(job.id) ?? [] });
    return employeeId ? [{ jobId: job.id, completedAt: job.completedAt as Date, employeeId }] : [];
  });
  const employeeIds = [...new Set(led.map((entry) => entry.employeeId))];
  const placements = await inChunks(employeeIds, (chunk) =>
    context.tx.organizationalAssignment.findMany({
      where: { tenantId: context.tenantId, employeeId: { in: chunk }, kind: "PRIMARY" },
      select: { employeeId: true, orgUnitId: true, effectiveFrom: true, effectiveTo: true },
    }),
  );
  const placementsOf = new Map<string, typeof placements>();
  for (const placement of placements) placementsOf.set(placement.employeeId, [...(placementsOf.get(placement.employeeId) ?? []), placement]);

  const facts: KpiFact[] = [];
  for (const entry of led) {
    const orgUnitId = placementAt(placementsOf.get(entry.employeeId) ?? [], entry.completedAt);
    if (orgUnitId === null || !context.unitVisible(orgUnitId)) continue;
    facts.push({ recordId: entry.jobId, at: entry.completedAt, orgUnitId, contributorId: entry.employeeId });
  }
  return facts;
};

export const OPERATIONAL_LOADERS: Record<string, KpiFactLoader> = {
  job_volume: jobVolume,
  completed_jobs: completedJobs,
  job_duration: jobDuration,
  revisit_rate: revisitRate,
  cancellation_rate: cancellationRate,
  time_to_assignment: timeToAssignment,
  time_to_arrival: timeToArrival,
  dispatch_recommendation_acceptance_rate: acceptanceRate,
  dispatch_decision_latency: decisionLatency,
  unassigned_jobs: unassignedJobs,
  jobs_per_employee: jobsPerEmployee,
};
