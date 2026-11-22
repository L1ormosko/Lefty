import type { Prisma } from "@prisma/client";
import { activePlacementWhere, type ResourceRef, type RowScopeAttributes } from "@/server/authz";
import type { TenantTx } from "@/server/db";
import type { ActiveAssignmentView, JobRow } from "./fields";

/**
 * How data scopes apply to jobs (§4.2, PERMISSIONS.md section 4), per record:
 *  - ORG_UNIT / LEGAL_ENTITY follow `Job.orgUnitId` (the service-area unit);
 *  - ASSIGNED = the caller is the employee of an ACTIVE `JobAssignment`, or a current member of the
 *    team of an ACTIVE team assignment (team expansion);
 *  - OWN matches nothing. Record-set grants (`recovery_related`, `customer_history`) are not
 *    expressed here: a job reference carries no sets, so such grants only count where a caller
 *    passes the set explicitly (the customer history view does).
 *
 * The query-side form of ASSIGNED is `jobAssignedToWhere` in `@/server/customers`; the functions here
 * are the per-record form and a test pins that both agree.
 */

export interface JobAccessFacts {
  /** The job's ACTIVE assignment rows (what the API shows). */
  assignments: ActiveAssignmentView[];
  /** Employees the job is assigned to: assignment employees plus current members of assigned teams. */
  assignedEmployeeIds: string[];
}

/**
 * Active assignments and assigned employee ids for a batch of jobs: three queries however many jobs
 * there are. Archived jobs assign nobody (same rule as `jobAssignedToWhere`). A team assignment expands
 * to the employees with an ACTIVE placement in exactly that unit while the unit is active.
 */
export async function loadJobAccessFacts(
  tx: TenantTx,
  tenantId: string,
  jobIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, JobAccessFacts>> {
  const facts = new Map<string, JobAccessFacts>(jobIds.map((jobId) => [jobId, { assignments: [], assignedEmployeeIds: [] }]));
  if (jobIds.length === 0) return facts;

  const rows = await tx.jobAssignment.findMany({
    where: { tenantId, state: "ACTIVE", jobId: { in: [...jobIds] }, job: { archivedAt: null } },
    select: { id: true, jobId: true, employeeId: true, teamOrgUnitId: true, role: true, method: true, assignedAt: true },
    orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
  });
  const teamIds = [...new Set(rows.map((row) => row.teamOrgUnitId).filter((team): team is string => team !== null))];
  const membersByTeam = await teamMembers(tx, tenantId, teamIds, now);

  const employeeIdsByJob = new Map<string, Set<string>>();
  for (const row of rows) {
    const entry = facts.get(row.jobId);
    if (!entry) continue;
    const { jobId, ...assignment } = row;
    entry.assignments.push(assignment);
    const employees = employeeIdsByJob.get(jobId) ?? new Set<string>();
    if (row.employeeId) employees.add(row.employeeId);
    if (row.teamOrgUnitId) for (const memberId of membersByTeam.get(row.teamOrgUnitId) ?? []) employees.add(memberId);
    employeeIdsByJob.set(jobId, employees);
  }
  for (const [jobId, employees] of employeeIdsByJob) {
    const entry = facts.get(jobId);
    if (entry) entry.assignedEmployeeIds = [...employees];
  }
  return facts;
}

/** Current members of each team org unit (active placement now, unit not archived). Teams that are archived or empty map to nothing. */
export async function teamMembers(tx: TenantTx, tenantId: string, teamOrgUnitIds: readonly string[], now: Date = new Date()): Promise<Map<string, string[]>> {
  const membersByTeam = new Map<string, string[]>();
  if (teamOrgUnitIds.length === 0) return membersByTeam;
  const placements = await tx.organizationalAssignment.findMany({
    where: { tenantId, orgUnitId: { in: [...teamOrgUnitIds] }, orgUnit: { active: true }, ...activePlacementWhere(now) },
    select: { orgUnitId: true, employeeId: true },
  });
  for (const placement of placements) {
    membersByTeam.set(placement.orgUnitId, [...(membersByTeam.get(placement.orgUnitId) ?? []), placement.employeeId]);
  }
  return membersByTeam;
}

/** `assignedEmployeeIds` per job (the `ResourceRef` form of ASSIGNED). Jobs with nobody assigned map to `[]`. */
export async function assignedEmployeeIdsByJob(tx: TenantTx, tenantId: string, jobIds: readonly string[], now: Date = new Date()): Promise<Map<string, string[]>> {
  const facts = await loadJobAccessFacts(tx, tenantId, jobIds, now);
  return new Map([...facts].map(([jobId, entry]) => [jobId, entry.assignedEmployeeIds]));
}

/** Select fragment the scope attributes of a job row need. */
export const jobScopeSelect = { id: true, orgUnitId: true, orgUnit: { select: { legalEntityId: true } } } satisfies Prisma.JobSelect;

type JobScopeRow = Pick<JobRow, "id" | "orgUnitId" | "orgUnit">;

/** What the scope engine needs to know about one job row (`fieldSetsForRow`). */
export function jobRowAttributes(row: JobScopeRow, facts: JobAccessFacts | undefined): RowScopeAttributes {
  return {
    orgUnitIds: [row.orgUnitId],
    legalEntityIds: row.orgUnit.legalEntityId ? [row.orgUnit.legalEntityId] : [],
    assignedEmployeeIds: facts?.assignedEmployeeIds ?? [],
  };
}

/** The `ResourceRef` of a job row, for `can` / `enforceInTx`. Always carries assigned ids, so a denial is a 404, never a 403. */
export function toJobResourceRef(row: Pick<JobRow, "orgUnitId">, facts: JobAccessFacts | undefined): ResourceRef {
  return { orgUnitId: row.orgUnitId, assignedEmployeeIds: facts?.assignedEmployeeIds ?? [], sets: [] };
}

/**
 * The resource reference of ONE job, read from the database in the caller's transaction. `null` when the
 * job does not exist in the tenant (callers answer 404). Routes use it as the `requirePermission`
 * resolver; services use it before `enforceInTx`.
 */
export async function jobResourceRef(tx: TenantTx, tenantId: string, jobId: string, now: Date = new Date()): Promise<ResourceRef | null> {
  const row = await tx.job.findFirst({ where: { id: jobId, tenantId }, select: jobScopeSelect });
  if (!row) return null;
  const facts = (await loadJobAccessFacts(tx, tenantId, [row.id], now)).get(row.id);
  return toJobResourceRef(row, facts);
}

/**
 * Locks the job row for the rest of the transaction (`SELECT ... FOR UPDATE`). Every service that
 * changes status, assignment or schedule calls it first, so two dispatchers acting on the same job
 * queue up instead of both reading the old state. Returns false when the job does not exist.
 */
export async function lockJob(tx: TenantTx, tenantId: string, jobId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE id = ${jobId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return rows.length > 0;
}
