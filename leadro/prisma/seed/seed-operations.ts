import { withTenant, type TenantTx } from "../../src/server/db";
import {
  BRANCH_COORDINATES,
  CERTIFICATIONS,
  JOB_TYPES,
  LEAD_SOURCES,
  SKILLS,
  TECHNICIAN_PROFILES,
  type QualificationSpec,
  type TechnicianProfile,
} from "./operations-specs";

export interface SeedOperationsResult {
  /** False when the tenant already had operational catalogs and nothing was changed. */
  created: boolean;
  skills: number;
  certifications: number;
  jobTypes: number;
  leadSources: number;
  technicians: number;
  qualifications: number;
}

const DAY_MS = 86_400_000;
const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);
/** `@db.Date` columns: keep only the calendar day (UTC). */
const dateOnly = (date: Date): Date => new Date(date.toISOString().slice(0, 10));

interface UnitRow {
  id: string;
  type: string;
  parentId: string | null;
  timeZone: string | null;
}

/** Nearest ancestor (or the unit itself) of the given type. */
function ancestorOfType(units: Map<string, UnitRow>, startId: string, type: string): UnitRow | undefined {
  for (let current = units.get(startId); current; current = current.parentId ? units.get(current.parentId) : undefined) {
    if (current.type === type) return current;
  }
  return undefined;
}

/** Time zone of the closest unit (self or ancestor) that has one, else the tenant default. */
function timeZoneFor(units: Map<string, UnitRow>, startId: string, fallback: string): string {
  for (let current = units.get(startId); current; current = current.parentId ? units.get(current.parentId) : undefined) {
    if (current.timeZone) return current.timeZone;
  }
  return fallback;
}

async function createCatalogs(tx: TenantTx, tenantId: string) {
  const skillIds = new Map<string, string>();
  for (const skill of SKILLS) {
    const row = await tx.skill.create({ data: { tenantId, ...skill }, select: { id: true } });
    skillIds.set(skill.code, row.id);
  }
  const certificationIds = new Map<string, string>();
  for (const certification of CERTIFICATIONS) {
    const row = await tx.certification.create({ data: { tenantId, ...certification }, select: { id: true } });
    certificationIds.set(certification.code, row.id);
  }
  for (const spec of JOB_TYPES) {
    const jobType = await tx.jobType.create({
      data: {
        tenantId,
        code: spec.code,
        name: spec.name,
        category: spec.category,
        defaultDurationMinutes: spec.defaultDurationMinutes,
        requiresReview: spec.requiresReview ?? false,
        requiredEquipment: spec.requiredEquipment,
      },
      select: { id: true },
    });
    for (const [code, minLevel] of spec.skills) {
      await tx.jobTypeSkill.create({ data: { tenantId, jobTypeId: jobType.id, skillId: must(skillIds, code), minLevel } });
    }
    for (const code of spec.certifications) {
      await tx.jobTypeCertification.create({ data: { tenantId, jobTypeId: jobType.id, certificationId: must(certificationIds, code) } });
    }
  }
  for (const source of LEAD_SOURCES) await tx.leadSource.create({ data: { tenantId, ...source } });
  return { skillIds, certificationIds };
}

function must(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Seed spec error: unknown code "${key}"`);
  return value;
}

async function createQualifications(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  verifierId: string,
  specs: QualificationSpec[],
  ids: { skillIds: Map<string, string>; certificationIds: Map<string, string> },
): Promise<number> {
  for (const spec of specs) {
    const skillId = ids.skillIds.get(spec.code);
    const isSkill = skillId !== undefined;
    const certification = CERTIFICATIONS.find((entry) => entry.code === spec.code);
    if (!isSkill && !certification) throw new Error(`Seed spec error: unknown qualification "${spec.code}"`);
    const verified = spec.status === "VERIFIED";
    await tx.employeeQualification.create({
      data: {
        tenantId,
        employeeId,
        kind: isSkill ? "SKILL" : certification!.type,
        skillId: isSkill ? skillId : undefined,
        certificationId: isSkill ? undefined : must(ids.certificationIds, spec.code),
        level: isSkill ? spec.level : undefined,
        number: spec.number,
        issuingAuthority: certification?.issuingAuthority,
        issuedAt: spec.issuedDaysAgo === undefined ? undefined : dateOnly(daysFromNow(-spec.issuedDaysAgo)),
        expiresAt: spec.expiresInDays === undefined || spec.expiresInDays === null ? undefined : dateOnly(daysFromNow(spec.expiresInDays)),
        status: spec.status,
        verifiedById: verified ? verifierId : undefined,
        verifiedAt: verified ? new Date() : undefined,
      },
    });
  }
  return specs.length;
}

async function createAvailability(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  profile: TechnicianProfile,
  timeZone: string,
): Promise<void> {
  const [startMinute, endMinute] = profile.hours ?? [480, 1020];
  for (const isoDayOfWeek of profile.weekdays) {
    await tx.availability.create({
      data: { tenantId, employeeId, kind: "WEEKLY_WINDOW", timeZone, isoDayOfWeek, startMinute, endMinute },
    });
  }
  if (profile.timeOff) {
    await tx.availability.create({
      data: {
        tenantId,
        employeeId,
        kind: "EXCEPTION_UNAVAILABLE",
        timeZone,
        startsAt: daysFromNow(profile.timeOff.startsInDays),
        endsAt: daysFromNow(profile.timeOff.startsInDays + profile.timeOff.days),
        note: profile.timeOff.note,
      },
    });
  }
}

/**
 * Seeds the operational catalogs (skills, certifications, job types with their requirements, lead
 * sources, default operations settings) and technicians with qualifications, service territories
 * and availability, for ONE existing tenant (created by `seedTenant`). No customers, leads or jobs.
 *
 * Technicians: the seeded user with the TECHNICIAN role gets the first profile; every TEAM unit gets
 * the other profiles as extra employees without a login (employee numbers `T-<team>-<n>`).
 * Idempotent: a tenant that already has skills is left unchanged.
 */
export async function seedOperationalData(tenantId: string, tenantSlug: string): Promise<SeedOperationsResult> {
  return withTenant(
    tenantId,
    async (tx) => {
      if ((await tx.skill.count()) > 0) {
        return { created: false, skills: 0, certifications: 0, jobTypes: 0, leadSources: 0, technicians: 0, qualifications: 0 };
      }
      await tx.operationsSettings.create({ data: { tenantId, enabledChannels: ["IN_APP"] } });

      const ids = await createCatalogs(tx, tenantId);
      for (const [name, [latitude, longitude]] of Object.entries(BRANCH_COORDINATES)) {
        await tx.orgUnit.updateMany({ where: { type: "BRANCH", name }, data: { latitude, longitude } });
      }
      const units = new Map((await tx.orgUnit.findMany({ select: { id: true, type: true, parentId: true, timeZone: true } })).map((unit) => [unit.id, unit]));
      const tenantRow = await tx.tenant.findUnique({ where: { id: tenantId }, select: { defaultTimeZone: true } });
      const defaultZone = tenantRow?.defaultTimeZone ?? "America/New_York";

      // Verifier: HR when present (credentials are HR records), else the first user.
      const verifier =
        (await tx.user.findFirst({ where: { email: `hr@${tenantSlug}.example.test` }, select: { id: true } })) ??
        (await tx.user.findFirstOrThrow({ select: { id: true } }));

      let technicians = 0;
      let qualifications = 0;
      const equip = async (employeeId: string, placeAtUnitId: string, profile: TechnicianProfile) => {
        const city = ancestorOfType(units, placeAtUnitId, "CITY");
        const region = ancestorOfType(units, placeAtUnitId, "REGION");
        const territoryUnit = profile.coversRegion ? (region ?? city) : city;
        if (territoryUnit) await tx.serviceTerritory.create({ data: { tenantId, employeeId, orgUnitId: territoryUnit.id, includeDescendants: true } });
        for (const category of profile.jobCategories) {
          await tx.employeeJobPermission.create({ data: { tenantId, employeeId, category, grantedById: verifier.id, reason: "Development seed" } });
        }
        qualifications += await createQualifications(tx, tenantId, employeeId, verifier.id, profile.qualifications, ids);
        await createAvailability(tx, tenantId, employeeId, profile, timeZoneFor(units, placeAtUnitId, defaultZone));
        technicians += 1;
      };

      // 1) The seeded Technician (has a login).
      const loginTechnician = await tx.employee.findFirst({
        where: { email: `technician@${tenantSlug}.example.test` },
        select: { id: true, assignments: { select: { orgUnitId: true }, take: 1 } },
      });
      const [senior, ...others] = TECHNICIAN_PROFILES;
      if (loginTechnician?.assignments[0]) await equip(loginTechnician.id, loginTechnician.assignments[0].orgUnitId, senior);

      // 2) Extra technicians (no login) in every team.
      const teams = [...units.values()].filter((unit) => unit.type === "TEAM");
      const sinceDate = daysFromNow(-365);
      for (const [teamIndex, team] of teams.entries()) {
        for (const [profileIndex, profile] of others.entries()) {
          const number = `T-${String(teamIndex + 1).padStart(2, "0")}-${profileIndex + 1}`;
          const employee = await tx.employee.create({
            data: {
              tenantId,
              employeeNumber: number,
              firstName: ["Sam", "Robin", "Alex", "Jamie", "Chris"][(teamIndex + profileIndex) % 5],
              lastName: ["Rivera", "Okoye", "Lindqvist", "Banerjee", "Moreau"][(teamIndex * 3 + profileIndex) % 5],
              jobTitle: profile.title,
              hireDate: sinceDate,
              assignments: { create: { orgUnitId: team.id, kind: "PRIMARY", effectiveFrom: sinceDate, reason: "Development seed" } },
            },
            select: { id: true },
          });
          await equip(employee.id, team.id, profile);
        }
      }

      return {
        created: true,
        skills: SKILLS.length,
        certifications: CERTIFICATIONS.length,
        jobTypes: JOB_TYPES.length,
        leadSources: LEAD_SOURCES.length,
        technicians,
        qualifications,
      };
    },
    { timeout: 60_000 },
  );
}
