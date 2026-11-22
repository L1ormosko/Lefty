import type { EligibilityInputs } from "@/server/qualifications";
import { NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * What the qualification engine needs to judge an employee for an existing job (it never reads job
 * tables itself): the job type and category, the service-area unit, the job's time zone and the job's
 * OWN requirement rows. Those rows are a snapshot taken at creation (job type skills and credentials,
 * plus manual additions), so later edits of the job type never change what an open job requires.
 *
 *   const inputs = await getJobEligibilityInputs(tx, tenantId, jobId);
 *   const { requirements, timeZone } = await requirementsFromInputs(tx, tenantId, inputs);
 *   const verdict = await isEligible(tx, tenantId, employeeId, requirements, { at, window, timeZone });
 *
 * No permission check: the caller (assignment, dispatch) has authorized itself over the job.
 * @throws NotFoundError when the job does not exist in the tenant.
 */
export async function getJobEligibilityInputs(tx: TenantTx, tenantId: string, jobId: string): Promise<EligibilityInputs> {
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
  return {
    jobTypeId: job.jobTypeId,
    jobCategory: job.jobType.category,
    orgUnitId: job.orgUnitId,
    timeZone: job.timeZone,
    requirements: job.requirements,
  };
}

export interface RequirementSeed {
  skillId?: string;
  certificationId?: string;
  minLevel?: number | null;
  source: "JOB_TYPE" | "MANUAL";
}

/**
 * The requirement rows a NEW job starts with: the job type's skills and credentials plus any manual
 * additions. A skill named twice keeps the higher minimum level (the stricter rule wins) and the
 * job-type source; a credential named twice appears once.
 */
export async function requirementSeedsForNewJob(
  tx: TenantTx,
  tenantId: string,
  jobTypeId: string,
  additional: { skills?: Array<{ skillId: string; minLevel?: number | null }>; certificationIds?: string[] } = {},
): Promise<RequirementSeed[]> {
  const type = await tx.jobType.findFirst({
    where: { id: jobTypeId, tenantId },
    select: { skills: { select: { skillId: true, minLevel: true } }, certifications: { select: { certificationId: true } } },
  });
  if (!type) throw new NotFoundError();

  const skills = new Map<string, RequirementSeed>();
  for (const skill of type.skills) skills.set(skill.skillId, { skillId: skill.skillId, minLevel: skill.minLevel, source: "JOB_TYPE" });
  for (const skill of additional.skills ?? []) {
    const existing = skills.get(skill.skillId);
    const level = skill.minLevel ?? null;
    if (!existing) skills.set(skill.skillId, { skillId: skill.skillId, minLevel: level, source: "MANUAL" });
    else if (level !== null && (existing.minLevel ?? 0) < level) existing.minLevel = level;
  }
  const certificationIds = new Map<string, RequirementSeed>();
  for (const row of type.certifications) certificationIds.set(row.certificationId, { certificationId: row.certificationId, source: "JOB_TYPE" });
  for (const certificationId of additional.certificationIds ?? []) {
    if (!certificationIds.has(certificationId)) certificationIds.set(certificationId, { certificationId, source: "MANUAL" });
  }
  return [...skills.values(), ...certificationIds.values()];
}
