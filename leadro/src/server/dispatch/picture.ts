import { haversineKm, type CandidateFacts, type CustomerPreference, type GeoPoint } from "@/lib/dispatch-scoring";
import type { EligibilityFailure } from "@/lib/eligibility";
import { activePlacementWhere } from "@/server/authz";
import { NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { getJobEligibilityInputs } from "@/server/jobs";
import { evaluateCandidates, requirementsFromInputs } from "@/server/qualifications";

/**
 * Everything the dispatch engine knows about one job at one moment: who passes the HARD eligibility
 * filter (the qualification engine: active employment, skills, credentials, territory, availability,
 * job-category permission) and why everybody else does not. Ranking (`@/lib/dispatch-scoring`) only ever
 * sees the eligible side. No permission check: the callers authorize over the job first.
 */

/** Upper bound on how many employees one pass evaluates; keeps one request bounded in very large tenants. */
export const MAX_POOL = 500;

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
  /** One entry per evaluated but ineligible employee, with EVERY failed rule. */
  blocked: Array<{ employeeId: string; failures: EligibilityFailure[] }>;
  /** Employees skipped because they already hold the job. */
  alreadyAssignedEmployeeIds: string[];
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

/** Runs the hard eligibility filter over the tenant's non-terminated employees (up to `MAX_POOL`). */
export async function buildEligibilityPicture(tx: TenantTx, tenantId: string, jobId: string, now: Date = new Date()): Promise<EligibilityPicture> {
  const job = await loadJobDispatchFacts(tx, tenantId, jobId);

  const held = await tx.jobAssignment.findMany({ where: { tenantId, jobId, state: "ACTIVE", employeeId: { not: null } }, select: { employeeId: true } });
  const alreadyAssignedEmployeeIds = held.flatMap((row) => (row.employeeId ? [row.employeeId] : []));

  const pool = await tx.employee.findMany({
    where: { tenantId, status: { not: "TERMINATED" }, id: { notIn: alreadyAssignedEmployeeIds } },
    select: { id: true },
    orderBy: { id: "asc" },
    take: MAX_POOL,
  });
  const { requirements, timeZone } = await requirementsFromInputs(tx, tenantId, await getJobEligibilityInputs(tx, tenantId, jobId));
  const verdicts = await evaluateCandidates(
    tx,
    tenantId,
    pool.map((employee) => employee.id),
    requirements,
    { at: now, window: job.window, timeZone },
  );

  const eligibleEmployeeIds: string[] = [];
  const blocked: EligibilityPicture["blocked"] = [];
  for (const { id } of pool) {
    const verdict = verdicts.get(id);
    if (!verdict) continue;
    if (verdict.eligible) eligibleEmployeeIds.push(id);
    else blocked.push({ employeeId: id, failures: verdict.failures });
  }
  return { job, eligibleEmployeeIds, blocked, alreadyAssignedEmployeeIds };
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
      select: { employeeId: true, jobId: true },
      distinct: ["employeeId", "jobId"],
    }),
    tx.customerPreferredEmployee.findMany({ where: { tenantId, customerId: job.customerId, employeeId: { in: employeeIds } }, select: { employeeId: true, kind: true } }),
  ]);
  const openByEmployee = new Map(openRows.flatMap((row) => (row.employeeId ? [[row.employeeId, row._count._all] as const] : [])));
  const completedByEmployee = new Map<string, number>();
  for (const row of completedRows) if (row.employeeId) completedByEmployee.set(row.employeeId, (completedByEmployee.get(row.employeeId) ?? 0) + 1);
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
