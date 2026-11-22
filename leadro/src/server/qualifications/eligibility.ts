import {
  evaluateEligibility,
  type EligibilityQuery,
  type EligibilityRequirements,
  type EligibilityResult,
  type EmployeeFacts,
} from "@/lib/eligibility";
import { NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { resolveWorkTimeZone } from "./time-zones";

/**
 * The qualification engine as other modules call it (dispatch, job assignment): load what is known
 * about employees, then apply the pure rules in `src/lib/eligibility`.
 *
 * These functions do NOT check permissions: they answer "may this person do this work", which the
 * caller (dispatch recommendations, assignment) needs from the system's point of view, after it has
 * checked its own permission over the job and the employee. The permission-checked entry for API
 * clients is `checkEligibilityAsActor` (`eligibility-check.ts`).
 *
 * Nothing here reads performance, ratings or workload (§10.3).
 */

/** Ids of an org unit and all its ancestors (nearest first), inside the caller's tenant. */
export async function orgUnitAncestry(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up(id, "parentId", depth) AS (
      SELECT id, "parentId", 0 FROM "OrgUnit" WHERE id = ${orgUnitId} AND "tenantId" = ${tenantId}
      UNION ALL
      SELECT parent.id, parent."parentId", up.depth + 1
      FROM "OrgUnit" parent JOIN up ON parent.id = up."parentId"
      WHERE parent."tenantId" = ${tenantId} AND up.depth < 30
    )
    SELECT id FROM up ORDER BY depth`;
  return rows.map((row) => row.id);
}

/** Loads the facts the rules need for several employees (one query per table, not per employee). Unknown ids are absent from the map. */
export async function loadEmployeeFacts(tx: TenantTx, tenantId: string, employeeIds: string[]): Promise<Map<string, EmployeeFacts>> {
  const ids = [...new Set(employeeIds)];
  const employees = await tx.employee.findMany({
    where: { tenantId, id: { in: ids } },
    select: {
      id: true,
      status: true,
      hireDate: true,
      terminationDate: true,
      qualifications: { select: { skillId: true, certificationId: true, level: true, status: true, expiresAt: true } },
      jobPermissions: { select: { jobTypeId: true, category: true, effectiveFrom: true, effectiveTo: true } },
      serviceTerritories: { select: { orgUnitId: true, includeDescendants: true, effectiveFrom: true, effectiveTo: true } },
      availabilities: {
        select: {
          kind: true,
          timeZone: true,
          isoDayOfWeek: true,
          startMinute: true,
          endMinute: true,
          validFrom: true,
          validTo: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
  });
  return new Map(
    employees.map((employee) => [
      employee.id,
      {
        employeeId: employee.id,
        status: employee.status,
        hireDate: employee.hireDate,
        terminationDate: employee.terminationDate,
        qualifications: employee.qualifications,
        jobPermissions: employee.jobPermissions,
        territories: employee.serviceTerritories,
        availability: employee.availabilities,
      },
    ]),
  );
}

/**
 * THE entry point: is `employeeId` eligible for work with these requirements, at this time?
 *
 * `query.at` is the decision time, `query.window` the span to work (appointment window or scheduled
 * slot, null = no time check) and `query.timeZone` the zone of the job (`resolveWorkTimeZone`).
 * Returns `{ eligible, failures[], checked }`; every failure is `{ code, params }` with no prose.
 *
 * @throws NotFoundError when the employee does not exist in the tenant.
 */
export async function isEligible(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  requirements: EligibilityRequirements,
  query: EligibilityQuery,
): Promise<EligibilityResult> {
  const facts = (await loadEmployeeFacts(tx, tenantId, [employeeId])).get(employeeId);
  if (!facts) throw new NotFoundError();
  return evaluateEligibility(facts, requirements, query);
}

/**
 * `isEligible` for many candidates at once (what dispatch ranking needs): one load, one verdict per
 * employee id. Ids that do not exist are left out of the result.
 */
export async function evaluateCandidates(
  tx: TenantTx,
  tenantId: string,
  employeeIds: string[],
  requirements: EligibilityRequirements,
  query: EligibilityQuery,
): Promise<Map<string, EligibilityResult>> {
  const facts = await loadEmployeeFacts(tx, tenantId, employeeIds);
  return new Map([...facts].map(([employeeId, employeeFacts]) => [employeeId, evaluateEligibility(employeeFacts, requirements, query)]));
}

// ───────────────────────── Building requirements ─────────────────────────

export interface AdditionalRequirements {
  /** Extra skills on top of the job type's ("requires additional qualification", §25.2). */
  skills?: Array<{ skillId: string; minLevel?: number | null }>;
  certificationIds?: string[];
}

/** Merges two lists keeping the stricter requirement per id (a higher minimum level wins). */
function mergeSkills(base: EligibilityRequirements["skills"], extra: EligibilityRequirements["skills"]): EligibilityRequirements["skills"] {
  const merged = new Map(base.map((skill) => [skill.skillId, skill]));
  for (const skill of extra) {
    const existing = merged.get(skill.skillId);
    if (!existing || (skill.minLevel ?? 0) > (existing.minLevel ?? 0)) merged.set(skill.skillId, existing ? { ...existing, minLevel: skill.minLevel } : skill);
  }
  return [...merged.values()];
}

async function certificationRequirements(tx: TenantTx, tenantId: string, ids: string[]): Promise<EligibilityRequirements["certifications"]> {
  if (ids.length === 0) return [];
  const rows = await tx.certification.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, type: true, name: true } });
  return rows.map((row) => ({ certificationId: row.id, kind: row.type as Exclude<typeof row.type, "SKILL">, name: row.name }));
}

async function skillRequirements(
  tx: TenantTx,
  tenantId: string,
  entries: Array<{ skillId: string; minLevel: number | null }>,
): Promise<EligibilityRequirements["skills"]> {
  if (entries.length === 0) return [];
  const names = new Map(
    (await tx.skill.findMany({ where: { tenantId, id: { in: entries.map((entry) => entry.skillId) } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]),
  );
  return entries.map((entry) => ({ skillId: entry.skillId, minLevel: entry.minLevel, name: names.get(entry.skillId) }));
}

/**
 * Requirements for a job TYPE (its skills, credentials and category) plus optional extras and the
 * service-area org unit. For "what if" checks and for jobs not yet created; for an existing job use
 * `requirementsForJob`, which reads the job's own snapshot.
 *
 * @throws NotFoundError for an unknown job type.
 */
export async function requirementsForJobType(
  tx: TenantTx,
  tenantId: string,
  jobTypeId: string,
  options: { orgUnitId?: string | null; additional?: AdditionalRequirements } = {},
): Promise<EligibilityRequirements> {
  const jobType = await tx.jobType.findFirst({
    where: { id: jobTypeId, tenantId },
    select: {
      id: true,
      category: true,
      skills: { select: { skillId: true, minLevel: true } },
      certifications: { select: { certificationId: true } },
    },
  });
  if (!jobType) throw new NotFoundError();

  const skills = await skillRequirements(tx, tenantId, jobType.skills);
  const extraSkills = await skillRequirements(
    tx,
    tenantId,
    (options.additional?.skills ?? []).map((skill) => ({ skillId: skill.skillId, minLevel: skill.minLevel ?? null })),
  );
  const certificationIds = [...new Set([...jobType.certifications.map((row) => row.certificationId), ...(options.additional?.certificationIds ?? [])])];
  return {
    jobTypeId: jobType.id,
    jobCategory: jobType.category,
    serviceArea: options.orgUnitId ? await serviceAreaOf(tx, tenantId, options.orgUnitId) : null,
    skills: mergeSkills(skills, extraSkills),
    certifications: await certificationRequirements(tx, tenantId, certificationIds),
  };
}

/**
 * Requirements of an existing job: its own `JobRequirement` rows (type defaults copied at creation
 * plus manual additions), its type and category, and its service-area org unit. Also returns the
 * zone to read dates in, so the caller can build the query: `job.timeZone`, else the unit's, else the company's.
 *
 * @throws NotFoundError for an unknown job.
 */
export async function requirementsForJob(
  tx: TenantTx,
  tenantId: string,
  jobId: string,
): Promise<{ requirements: EligibilityRequirements; timeZone: string }> {
  const job = await tx.job.findFirst({
    where: { id: jobId, tenantId },
    select: {
      jobTypeId: true,
      orgUnitId: true,
      timeZone: true,
      jobType: { select: { category: true } },
      requirements: { select: { skillId: true, certificationId: true, minLevel: true } },
    },
  });
  if (!job) throw new NotFoundError();

  const skillEntries = job.requirements.flatMap((row) => (row.skillId ? [{ skillId: row.skillId, minLevel: row.minLevel }] : []));
  const certificationIds = job.requirements.flatMap((row) => (row.certificationId ? [row.certificationId] : []));
  return {
    requirements: {
      jobTypeId: job.jobTypeId,
      jobCategory: job.jobType.category,
      serviceArea: await serviceAreaOf(tx, tenantId, job.orgUnitId),
      skills: await skillRequirements(tx, tenantId, skillEntries),
      certifications: await certificationRequirements(tx, tenantId, certificationIds),
    },
    timeZone: await resolveWorkTimeZone(tx, tenantId, { jobTimeZone: job.timeZone, orgUnitId: job.orgUnitId }),
  };
}

async function serviceAreaOf(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<NonNullable<EligibilityRequirements["serviceArea"]>> {
  const ancestry = await orgUnitAncestry(tx, tenantId, orgUnitId);
  if (ancestry.length === 0) throw new NotFoundError();
  return { orgUnitId, ancestorOrgUnitIds: ancestry.filter((id) => id !== orgUnitId) };
}
