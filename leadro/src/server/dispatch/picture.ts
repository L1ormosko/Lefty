import type { Prisma } from "@prisma/client";
import { haversineKm, type CandidateFacts, type CustomerPreference, type GeoPoint } from "@/lib/dispatch-scoring";
import type { EligibilityFailure } from "@/lib/eligibility";
import { activePlacementWhere, employeeScopeColumns, scopeFilterInTx } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { getJobEligibilityInputs } from "@/server/jobs";
import { evaluateCandidates, orgUnitAncestry, requirementsFromInputs } from "@/server/qualifications";

/**
 * Everything the dispatch engine knows about one job at one moment: who passes the HARD eligibility
 * filter (the qualification engine: active employment, skills, credentials, territory, availability,
 * job-category permission) and why everybody else does not. Ranking (`@/lib/dispatch-scoring`) only ever
 * sees the eligible side. No permission check: the callers authorize over the job first.
 */

/** Employees loaded and judged per round trip. */
const PAGE_SIZE = 500;
/**
 * Hard ceiling on employees judged in one pass. It is only reached by a very large tenant AFTER the SQL pre-filter (territory
 * or job permission, in the caller's scope); the picture then says so (`poolTruncated`) and callers must never treat a
 * truncated "nobody eligible" as the truth.
 */
export const MAX_EVALUATED = 5000;

/** Statuses in which an ACTIVE assignment still counts as workload ("open jobs"). */
const OPEN_JOB_STATUSES = ["ASSIGNED", "SCHEDULED", "RESCHEDULED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "ON_HOLD"] as const;
/** Statuses that mean the work was done (experience = completed jobs of the same type; a count, never a rating). */
const COMPLETED_JOB_STATUSES = ["COMPLETED", "AWAITING_REVIEW", "CLOSED"] as const;

export interface JobDispatchFacts {
  id: string;
  status: string;
  jobTypeId: string;
  customerId: string;
  orgUnitId: string;
  site: GeoPoint | null;
  window: { startsAt: Date; endsAt: Date } | null;
}

export interface EligibilityPicture {
  job: JobDispatchFacts;
  eligibleEmployeeIds: string[];
  /** Employees the caller may see who were judged and are NOT eligible, with EVERY failed rule. Never includes anyone out of scope. */
  blocked: Array<{ employeeId: string; failures: EligibilityFailure[] }>;
  /** Employees skipped because they already hold the job. */
  alreadyAssignedEmployeeIds: string[];
  /** How many employees were judged. */
  evaluatedCount: number;
  /** Relevant employees (territory or permission match) the caller may not see: counted, never named, never judged for the caller. */
  outOfScopeCount: number;
  /** Employees the caller may see (not terminated, not on the job) with NEITHER a territory covering the job's area NOR a permission for its type: not candidates, counted so an empty result explains itself. */
  notRelevantCount: number;
  /** True when `MAX_EVALUATED` stopped the pass: the lists may be incomplete. */
  poolTruncated: boolean;
}

const pointOf = (latitude: { toNumber(): number } | null, longitude: { toNumber(): number } | null): GeoPoint | null =>
  latitude !== null && longitude !== null ? { latitude: latitude.toNumber(), longitude: longitude.toNumber() } : null;

/** The job facts dispatch needs (status, type, customer, site coordinates, the span to be worked). */
export async function loadJobDispatchFacts(tx: TenantTx, tenantId: string, jobId: string): Promise<JobDispatchFacts> {
  const job = await tx.job.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true,
      status: true,
      jobTypeId: true,
      customerId: true,
      orgUnitId: true,
      scheduledStartAt: true,
      scheduledEndAt: true,
      appointmentWindowStart: true,
      appointmentWindowEnd: true,
      serviceAddress: { select: { latitude: true, longitude: true } },
    },
  });
  if (!job) throw new NotFoundError();
  // The scheduled slot wins over the customer's appointment window (same rule as assignment).
  const window =
    job.scheduledStartAt && job.scheduledEndAt
      ? { startsAt: job.scheduledStartAt, endsAt: job.scheduledEndAt }
      : job.appointmentWindowStart && job.appointmentWindowEnd
        ? { startsAt: job.appointmentWindowStart, endsAt: job.appointmentWindowEnd }
        : null;
  return {
    id: job.id,
    status: job.status,
    jobTypeId: job.jobTypeId,
    customerId: job.customerId,
    orgUnitId: job.orgUnitId,
    site: pointOf(job.serviceAddress.latitude, job.serviceAddress.longitude),
    window,
  };
}

/**
 * Runs the hard eligibility filter for the CALLER (§4.2, §10): only employees the caller may see (`employees.view`, any field
 * set) are judged or listed, because the failures carry HR facts (credential expiry, skill level, time off). The pool is
 * pre-filtered in SQL to non-terminated employees with a service territory covering the job's area OR a permission for its
 * job type / category (the two rules every eligible employee must satisfy; employees matching neither are not "candidates"),
 * then judged in pages of `PAGE_SIZE` up to `evaluationLimit` (default `MAX_EVALUATED`; a parameter so the ceiling is testable).
 */
export async function buildEligibilityPicture(
  tx: TenantTx,
  actor: Actor,
  jobId: string,
  now: Date = new Date(),
  evaluationLimit: number = MAX_EVALUATED,
): Promise<EligibilityPicture> {
  const tenantId = actor.tenantId;
  const job = await loadJobDispatchFacts(tx, tenantId, jobId);

  const held = await tx.jobAssignment.findMany({ where: { tenantId, jobId, state: "ACTIVE", employeeId: { not: null } }, select: { employeeId: true } });
  const alreadyAssignedEmployeeIds = held.flatMap((row) => (row.employeeId ? [row.employeeId] : []));

  const jobType = await tx.jobType.findFirst({ where: { id: job.jobTypeId, tenantId }, select: { category: true } });
  const ancestry = await orgUnitAncestry(tx, tenantId, job.orgUnitId);
  const relevant: Prisma.EmployeeWhereInput = {
    tenantId,
    status: { not: "TERMINATED" },
    id: { notIn: alreadyAssignedEmployeeIds },
    OR: [
      {
        serviceTerritories: {
          some: { OR: [{ orgUnitId: job.orgUnitId }, { includeDescendants: true, orgUnitId: { in: ancestry } }] },
        },
      },
      {
        jobPermissions: {
          some: { OR: [{ jobTypeId: job.jobTypeId }, ...(jobType ? [{ category: jobType.category }] : [])] },
        },
      },
    ],
  };
  const visible = await scopeFilterInTx(tx, actor, "employees.view", employeeScopeColumns);
  // relevant minus visible-and-relevant: a tenant-wide scope is the empty filter `{}`, so `NOT: visible` would match nobody-or-everybody.
  const relevantInScope = await tx.employee.count({ where: { AND: [relevant, visible] } });
  const outOfScopeCount = (await tx.employee.count({ where: relevant })) - relevantInScope;
  const notRelevantCount = await tx.employee.count({
    where: { AND: [visible, { tenantId, status: { not: "TERMINATED" }, id: { notIn: alreadyAssignedEmployeeIds }, NOT: { OR: relevant.OR as Prisma.EmployeeWhereInput[] } }] },
  });

  const { requirements, timeZone } = await requirementsFromInputs(tx, tenantId, await getJobEligibilityInputs(tx, tenantId, jobId));
  const eligibleEmployeeIds: string[] = [];
  const blocked: EligibilityPicture["blocked"] = [];
  let evaluatedCount = 0;
  let poolTruncated = false;
  let after: string | undefined;
  while (true) {
    const page = await tx.employee.findMany({
      where: { AND: [relevant, visible, after ? { id: { gt: after } } : {}] },
      select: { id: true },
      orderBy: { id: "asc" },
      take: Math.min(PAGE_SIZE, evaluationLimit - evaluatedCount),
    });
    if (page.length === 0) break;
    const verdicts = await evaluateCandidates(
      tx,
      tenantId,
      page.map((employee) => employee.id),
      requirements,
      { at: now, window: job.window, timeZone },
    );
    for (const { id } of page) {
      const verdict = verdicts.get(id);
      if (!verdict) continue;
      if (verdict.eligible) eligibleEmployeeIds.push(id);
      else blocked.push({ employeeId: id, failures: verdict.failures });
    }
    evaluatedCount += page.length;
    after = page[page.length - 1].id;
    if (evaluatedCount >= evaluationLimit) {
      // Truncated only if somebody is left over.
      poolTruncated = (await tx.employee.count({ where: { AND: [relevant, visible, { id: { gt: after } }] } })) > 0;
      break;
    }
  }
  return { job, eligibleEmployeeIds, blocked, alreadyAssignedEmployeeIds, evaluatedCount, outOfScopeCount, notRelevantCount, poolTruncated };
}

/** Where each employee starts from: their own start point, else the coordinates of their current primary unit. */
async function startPoints(tx: TenantTx, tenantId: string, employeeIds: string[], now: Date): Promise<Map<string, GeoPoint>> {
  const employees = await tx.employee.findMany({ where: { tenantId, id: { in: employeeIds } }, select: { id: true, startLatitude: true, startLongitude: true } });
  const points = new Map<string, GeoPoint>();
  for (const employee of employees) {
    const own = pointOf(employee.startLatitude, employee.startLongitude);
    if (own) points.set(employee.id, own);
  }
  const missing = employeeIds.filter((id) => !points.has(id));
  if (missing.length > 0) {
    const placements = await tx.organizationalAssignment.findMany({
      where: { tenantId, employeeId: { in: missing }, kind: "PRIMARY", ...activePlacementWhere(now) },
      select: { employeeId: true, orgUnit: { select: { latitude: true, longitude: true } } },
    });
    for (const placement of placements) {
      const unitPoint = pointOf(placement.orgUnit.latitude, placement.orgUnit.longitude);
      if (unitPoint && !points.has(placement.employeeId)) points.set(placement.employeeId, unitPoint);
    }
  }
  return points;
}

/**
 * The soft-factor inputs for the eligible employees: straight-line distance, open workload, completed
 * jobs of this job type, and the customer's preferred / avoid list. Four batched queries, never one per
 * employee. Contains NO performance data (§7.3, §10.3).
 */
export async function loadCandidateFacts(tx: TenantTx, tenantId: string, job: JobDispatchFacts, employeeIds: string[], now: Date = new Date()): Promise<CandidateFacts[]> {
  if (employeeIds.length === 0) return [];
  const [points, openRows, completedRows, preferences] = await Promise.all([
    startPoints(tx, tenantId, employeeIds, now),
    tx.jobAssignment.groupBy({
      by: ["employeeId"],
      where: { tenantId, employeeId: { in: employeeIds }, state: "ACTIVE", job: { status: { in: [...OPEN_JOB_STATUSES] }, archivedAt: null } },
      _count: { _all: true },
    }),
    tx.jobAssignment.findMany({
      where: { tenantId, employeeId: { in: employeeIds }, job: { jobTypeId: job.jobTypeId, status: { in: [...COMPLETED_JOB_STATUSES] } } },
      select: { employeeId: true, jobId: true, assignedAt: true },
    }),
    tx.customerPreferredEmployee.findMany({ where: { tenantId, customerId: job.customerId, employeeId: { in: employeeIds } }, select: { employeeId: true, kind: true } }),
  ]);
  // Experience counts the work a person actually did: for a job that changed hands, only the LAST assignee (the one it was
  // assigned to when it finished), never someone it was reassigned away from.
  const latestAssignedAt = new Map(
    (
      await tx.jobAssignment.groupBy({ by: ["jobId"], where: { tenantId, jobId: { in: [...new Set(completedRows.map((row) => row.jobId))] } }, _max: { assignedAt: true } })
    ).map((row) => [row.jobId, row._max.assignedAt?.getTime() ?? null]),
  );
  const openByEmployee = new Map(openRows.flatMap((row) => (row.employeeId ? [[row.employeeId, row._count._all] as const] : [])));
  const completedByEmployee = new Map<string, number>();
  for (const row of completedRows) if (row.employeeId && row.assignedAt.getTime() === latestAssignedAt.get(row.jobId)) completedByEmployee.set(row.employeeId, (completedByEmployee.get(row.employeeId) ?? 0) + 1);
  const preferenceByEmployee = new Map<string, CustomerPreference>(preferences.map((row) => [row.employeeId, row.kind]));

  return employeeIds.map((employeeId) => {
    const start = points.get(employeeId);
    return {
      employeeId,
      distanceKm: job.site && start ? haversineKm(start, job.site) : null,
      openJobCount: openByEmployee.get(employeeId) ?? 0,
      completedOfTypeCount: completedByEmployee.get(employeeId) ?? 0,
      customerPreference: preferenceByEmployee.get(employeeId) ?? null,
    };
  });
}
