import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listExpiring } from "@/app/api/v1/qualifications/expiring/route";
import { POST as checkEligibility } from "@/app/api/v1/qualifications/eligibility/route";
import { createTranslator } from "@/lib/i18n";
import { addDays, localIsoDate } from "@/lib/zoned-time";
import { withTenant } from "@/server/db";
import {
  evaluateCandidates,
  findExpiringQualifications,
  isEligible,
  renderEligibilityFailure,
  requirementsFromInputs,
  requirementsForJobType,
} from "@/server/qualifications";
import { buildWorld, createPerson, disconnect, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

let w: World;
let dispatcher: string;
let hr: string;
let techA1Cookie: string;

const ids = {
  hvac: "",
  epa: "",
  jobType: "",
  otherJobType: "",
};

/** Window on a fixed future Wednesday, 09:00-11:00 New York (the company default zone). */
const WINDOW = { startsAt: new Date("2026-12-09T14:00:00Z"), endsAt: new Date("2026-12-09T16:00:00Z") };
const query = (extra: Record<string, unknown> = {}) => ({ at: new Date("2026-11-22T12:00:00Z"), window: WINDOW, timeZone: "America/New_York", ...extra });
// Days are counted from the tenant-local date (New York), as the service does; a UTC date would be a day ahead
// between midnight UTC and midnight New York and make the expiry assertions fail at those hours.
const daysFromNow = (days: number) => new Date(`${addDays(localIsoDate(Date.now(), "America/New_York"), days)}T00:00:00Z`);

async function qualify(employeeId: string, data: { skillId?: string; certificationId?: string; kind: "SKILL" | "LICENSE"; level?: number; expiresAt?: Date | null; status?: "VERIFIED" | "PENDING_VERIFICATION" }) {
  const status = data.status ?? "VERIFIED";
  return withTenant(w.tenantId, (tx) =>
    tx.employeeQualification.create({
      data: {
        tenantId: w.tenantId,
        employeeId,
        kind: data.kind,
        skillId: data.skillId,
        certificationId: data.certificationId,
        level: data.level,
        expiresAt: data.expiresAt,
        status,
        ...(status === "VERIFIED" ? { verifiedById: w.hr.userId, verifiedAt: new Date() } : {}),
      },
    }),
  );
}

/** Makes `employeeId` fully eligible for the fixture job type in City A: permission, territory, 24/7 availability. */
async function equip(employeeId: string) {
  await withTenant(w.tenantId, async (tx) => {
    await tx.employeeJobPermission.create({ data: { tenantId: w.tenantId, employeeId, category: "repair", effectiveFrom: new Date("2025-01-01T00:00:00Z") } });
    await tx.serviceTerritory.create({ data: { tenantId: w.tenantId, employeeId, orgUnitId: w.units.cityA, includeDescendants: true, effectiveFrom: new Date("2025-01-01T00:00:00Z") } });
    for (let day = 1; day <= 7; day++) {
      await tx.availability.create({ data: { tenantId: w.tenantId, employeeId, kind: "WEEKLY_WINDOW", timeZone: "America/New_York", isoDayOfWeek: day, startMinute: 0, endMinute: 1440 } });
    }
  });
}

beforeAll(async () => {
  w = await buildWorld("elig");
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  hr = await sessionCookie(w.hr, w.tenantId);
  techA1Cookie = await sessionCookie(w.techA1, w.tenantId);

  await withTenant(w.tenantId, async (tx) => {
    const hvac = await tx.skill.create({ data: { tenantId: w.tenantId, code: "hvac", name: "HVAC" } });
    const epa = await tx.certification.create({ data: { tenantId: w.tenantId, code: "epa-608", name: "EPA 608", type: "LICENSE" } });
    const jobType = await tx.jobType.create({
      data: {
        tenantId: w.tenantId,
        code: "hvac-repair",
        name: "HVAC repair",
        category: "repair",
        defaultDurationMinutes: 120,
      },
    });
    await tx.jobTypeSkill.create({ data: { tenantId: w.tenantId, jobTypeId: jobType.id, skillId: hvac.id, minLevel: 3 } });
    await tx.jobTypeCertification.create({ data: { tenantId: w.tenantId, jobTypeId: jobType.id, certificationId: epa.id } });
    const otherJobType = await tx.jobType.create({ data: { tenantId: w.tenantId, code: "install", name: "Install", category: "installation", defaultDurationMinutes: 240 } });
    Object.assign(ids, { hvac: hvac.id, epa: epa.id, jobType: jobType.id, otherJobType: otherJobType.id });
  });
});
afterAll(disconnect);

describe("building requirements", () => {
  it("requirementsForJobType reads the type's skills, credentials, category and the service area with its ancestors", async () => {
    const requirements = await withTenant(w.tenantId, (tx) => requirementsForJobType(tx, w.tenantId, ids.jobType, { orgUnitId: w.units.teamA1 }));
    expect(requirements).toMatchObject({
      jobTypeId: ids.jobType,
      jobCategory: "repair",
      skills: [{ skillId: ids.hvac, minLevel: 3, name: "HVAC" }],
      certifications: [{ certificationId: ids.epa, kind: "LICENSE", name: "EPA 608" }],
    });
    expect(requirements.serviceArea?.orgUnitId).toBe(w.units.teamA1);
    expect(requirements.serviceArea?.ancestorOrgUnitIds).toEqual([w.units.cityA, w.units.state]);
  });

  it("extras are added on top; the stricter minimum level wins; unknown types are not found", async () => {
    const stricter = await withTenant(w.tenantId, (tx) => requirementsForJobType(tx, w.tenantId, ids.jobType, { additional: { skills: [{ skillId: ids.hvac, minLevel: 5 }] } }));
    expect(stricter.skills).toHaveLength(1);
    expect(stricter.skills[0].minLevel).toBe(5);
    expect(stricter.serviceArea).toBeNull();
    await expect(withTenant(w.tenantId, (tx) => requirementsForJobType(tx, w.tenantId, "nope"))).rejects.toThrow();
  });

  it("requirementsFromInputs turns the jobs module's inputs into requirements (names, ancestry) and resolves the zone: job zone beats the unit's and the company's", async () => {
    const inputs = {
      jobTypeId: ids.jobType,
      jobCategory: "repair",
      orgUnitId: w.units.teamA1,
      timeZone: "America/Chicago",
      requirements: [{ skillId: ids.hvac, minLevel: 4 }, { certificationId: ids.epa }],
    };
    const { requirements, timeZone } = await withTenant(w.tenantId, (tx) => requirementsFromInputs(tx, w.tenantId, inputs));
    expect(requirements.skills).toEqual([{ skillId: ids.hvac, minLevel: 4, name: "HVAC" }]);
    expect(requirements.certifications.map((row) => row.certificationId)).toEqual([ids.epa]);
    expect(requirements.serviceArea?.orgUnitId).toBe(w.units.teamA1);
    expect(timeZone).toBe("America/Chicago");
    const fallback = await withTenant(w.tenantId, (tx) => requirementsFromInputs(tx, w.tenantId, { ...inputs, timeZone: null }));
    expect(fallback.timeZone).toBe("America/New_York"); // company default
  });
});

describe("isEligible and evaluateCandidates against the database", () => {
  it("a fully qualified employee is eligible; each missing piece is reported", async () => {
    const full = await createPerson(w.tenantId, "full", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    await equip(full.employeeId as string);
    await qualify(full.employeeId as string, { kind: "SKILL", skillId: ids.hvac, level: 4 });
    await qualify(full.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(400) });

    const bare = await createPerson(w.tenantId, "bare", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });

    const verdicts = await withTenant(w.tenantId, async (tx) => {
      const requirements = await requirementsForJobType(tx, w.tenantId, ids.jobType, { orgUnitId: w.units.teamA1 });
      return {
        requirements,
        full: await isEligible(tx, w.tenantId, full.employeeId as string, requirements, query()),
        bare: await isEligible(tx, w.tenantId, bare.employeeId as string, requirements, query()),
        batch: await evaluateCandidates(tx, w.tenantId, [full.employeeId as string, bare.employeeId as string, "unknown-id"], requirements, query()),
      };
    });
    expect(verdicts.full).toMatchObject({ eligible: true, failures: [] });
    expect(verdicts.bare.failures.map((failure) => failure.code)).toEqual([
      "QUALIFICATION_MISSING",
      "QUALIFICATION_MISSING",
      "JOB_PERMISSION_MISSING",
      "OUTSIDE_TERRITORY",
      "UNAVAILABLE_OUTSIDE_HOURS",
    ]);
    expect([...verdicts.batch.keys()].sort()).toEqual([full.employeeId, bare.employeeId].sort());
    expect(verdicts.batch.get(full.employeeId as string)?.eligible).toBe(true);
  });

  it("pending, expired and low-level records do not count; the right code is reported for each", async () => {
    const person = await createPerson(w.tenantId, "partial", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    const employeeId = person.employeeId as string;
    await equip(employeeId);
    await qualify(employeeId, { kind: "SKILL", skillId: ids.hvac, level: 2 });
    await qualify(employeeId, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(-3) });
    const failures = await withTenant(w.tenantId, async (tx) => {
      const requirements = await requirementsForJobType(tx, w.tenantId, ids.jobType);
      return (await isEligible(tx, w.tenantId, employeeId, requirements, query())).failures.map((failure) => failure.code);
    });
    expect(failures).toEqual(["SKILL_LEVEL_TOO_LOW", "QUALIFICATION_EXPIRED"]);
  });

  it("a job-category permission for another category does not count; a terminated employee is not eligible", async () => {
    const person = await createPerson(w.tenantId, "wrongcat", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    await equip(person.employeeId as string);
    const result = await withTenant(w.tenantId, async (tx) => {
      const requirements = await requirementsForJobType(tx, w.tenantId, ids.otherJobType); // category "installation"
      const wrong = await isEligible(tx, w.tenantId, person.employeeId as string, requirements, query());
      await tx.employee.update({ where: { id: person.employeeId as string }, data: { status: "TERMINATED", terminationDate: new Date("2026-01-01T00:00:00Z") } });
      const terminated = await isEligible(tx, w.tenantId, person.employeeId as string, requirements, query());
      return { wrong, terminated };
    });
    expect(result.wrong.failures.map((failure) => failure.code)).toEqual(["JOB_PERMISSION_MISSING"]);
    expect(result.terminated.failures.map((failure) => failure.code)).toContain("EMPLOYEE_NOT_ACTIVE");
  });

  it("a territory on an archived unit stops covering, and an ON_LEAVE employee can still be scheduled ahead", async () => {
    const person = await createPerson(w.tenantId, "archived-terr", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    const employeeId = person.employeeId as string;
    await equip(employeeId);
    await qualify(employeeId, { kind: "SKILL", skillId: ids.hvac, level: 4 });
    await qualify(employeeId, { kind: "LICENSE", certificationId: ids.epa });
    const run = (extra: Record<string, unknown> = {}) =>
      withTenant(w.tenantId, async (tx) => {
        const requirements = await requirementsForJobType(tx, w.tenantId, ids.jobType, { orgUnitId: w.units.cityA });
        return (await isEligible(tx, w.tenantId, employeeId, requirements, query(extra))).failures.map((failure) => failure.code);
      });
    expect(await run()).toEqual([]);
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: employeeId }, data: { status: "ON_LEAVE" } }));
    expect(await run()).toEqual([]); // future window: leave is an availability exception, not a status
    expect(await run({ at: WINDOW.startsAt })).toEqual(["EMPLOYEE_NOT_ACTIVE"]);
    await withTenant(w.tenantId, (tx) => tx.orgUnit.update({ where: { id: w.units.cityA }, data: { active: false } }));
    expect(await run()).toEqual(["OUTSIDE_TERRITORY"]);
    await withTenant(w.tenantId, (tx) => tx.orgUnit.update({ where: { id: w.units.cityA }, data: { active: true } }));
  });

  it("does not see another tenant's employee (row-level security): not found", async () => {
    const foreign = await buildWorld("elig-foreign");
    await expect(
      withTenant(w.tenantId, async (tx) => {
        const requirements = await requirementsForJobType(tx, w.tenantId, ids.jobType);
        return isEligible(tx, w.tenantId, foreign.techA1.employeeId as string, requirements, query());
      }),
    ).rejects.toThrow();
  });

  it("failures render in the viewer's language from code + params, with no prose in the result", async () => {
    const bare = await createPerson(w.tenantId, "bare2", { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    const result = await withTenant(w.tenantId, async (tx) => {
      const requirements = await requirementsForJobType(tx, w.tenantId, ids.jobType);
      return isEligible(tx, w.tenantId, bare.employeeId as string, requirements, query({ window: null }));
    });
    const missingSkill = result.failures[0];
    expect(missingSkill).toEqual({ code: "QUALIFICATION_MISSING", params: { kind: "SKILL", id: ids.hvac, name: "HVAC" } });
    expect(renderEligibilityFailure(createTranslator({ localeChain: ["en-US"] }), missingSkill)).toBe("Missing required skill: HVAC.");
    expect(renderEligibilityFailure(createTranslator({ localeChain: ["es-US"] }), missingSkill)).toBe("Falta un requisito: habilidad HVAC.");
    expect(renderEligibilityFailure(createTranslator({ localeChain: ["he-IL"] }), missingSkill)).toContain("HVAC");
  });
});

describe("POST /api/v1/qualifications/eligibility", () => {
  it("answers for an employee in scope, with codes and params, and 404s for one outside it", async () => {
    const check = (cookie: string, body: Record<string, unknown>) => call(checkEligibility, "POST", "/x", { cookie, body });
    const body = { employeeId: w.techA1.employeeId, jobTypeId: ids.jobType, orgUnitId: w.units.teamA1, startsAt: "2026-12-09T14:00:00Z", endsAt: "2026-12-09T16:00:00Z" };

    const denied = await check(dispatcher, body);
    expect(denied.status).toBe(200);
    expect(denied.json.data.eligible).toBe(false);
    expect(denied.json.data.checked).toEqual({ availability: true, territory: true, jobPermission: true });
    expect(denied.json.data.timeZone).toBe("America/New_York");
    expect(denied.json.data.failures.map((failure: { code: string }) => failure.code)).toContain("QUALIFICATION_MISSING");
    expect(JSON.stringify(denied.json.data)).not.toMatch(/message/i);

    await equip(w.techA1.employeeId as string);
    await qualify(w.techA1.employeeId as string, { kind: "SKILL", skillId: ids.hvac, level: 5 });
    await qualify(w.techA1.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: null });
    const allowed = await check(dispatcher, body);
    expect(allowed.json.data).toMatchObject({ eligible: true, failures: [] });

    const withExtra = await check(dispatcher, { ...body, extraSkills: [{ skillId: ids.hvac, minLevel: 5 }] });
    expect(withExtra.json.data.eligible).toBe(true);
    const noTime = await check(dispatcher, { employeeId: w.techA1.employeeId, jobTypeId: ids.jobType });
    expect(noTime.json.data.checked).toEqual({ availability: false, territory: false, jobPermission: true });

    expect((await check(dispatcher, { ...body, jobTypeId: "nope" })).status).toBe(400);
    expect((await check(dispatcher, { ...body, extraCertificationIds: ["nope"] })).status).toBe(400);
    expect((await check(dispatcher, { ...body, endsAt: undefined })).status).toBe(400);
    expect((await check(dispatcher, { ...body, employeeId: w.techB.employeeId })).status).toBe(200); // the dispatcher covers the whole state
    expect((await check(techA1Cookie, { ...body, employeeId: w.techA1Other.employeeId })).status).toBe(404); // a technician sees only themselves
    expect((await check(techA1Cookie, body)).status).toBe(200);
  });
});

describe("credentials expiring within N days", () => {
  it("lists verified, soon-to-expire records of active employees, soonest first, scoped for the API", async () => {
    const soon = await createPerson(w.tenantId, "expiring-soon", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    const later = await createPerson(w.tenantId, "expiring-later", { orgUnitId: w.units.cityB, legalEntityId: w.legalEntityId });
    const gone = await createPerson(w.tenantId, "expiring-gone", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    const rows = {
      soon: await qualify(soon.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(10) }),
      today: await qualify(later.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(0) }),
      far: await qualify(soon.employeeId as string, { kind: "SKILL", skillId: ids.hvac, level: 3, expiresAt: daysFromNow(120) }),
      pending: await qualify(later.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(5), status: "PENDING_VERIFICATION" }),
      expired: await qualify(later.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(-2) }),
      terminated: await qualify(gone.employeeId as string, { kind: "LICENSE", certificationId: ids.epa, expiresAt: daysFromNow(3) }),
    };
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: gone.employeeId as string }, data: { status: "TERMINATED", terminationDate: new Date("2026-01-01T00:00:00Z") } }));

    const system = await withTenant(w.tenantId, (tx) => findExpiringQualifications(tx, w.tenantId, { withinDays: 30 }));
    const systemIds = system.map((row) => row.qualificationId);
    expect(systemIds).toContain(rows.soon.id);
    expect(systemIds).toContain(rows.today.id);
    for (const excluded of [rows.far, rows.pending, rows.expired, rows.terminated]) expect(systemIds).not.toContain(excluded.id);
    expect(systemIds.indexOf(rows.today.id)).toBeLessThan(systemIds.indexOf(rows.soon.id));
    expect(system.find((row) => row.qualificationId === rows.today.id)?.daysRemaining).toBe(0);
    expect(system.find((row) => row.qualificationId === rows.soon.id)).toMatchObject({ userId: soon.userId, kind: "LICENSE", name: "EPA 608", daysRemaining: 10 });

    // The default horizon is the tenant's qualificationWarningDays (30 when unset), and it can be changed.
    const byDefault = await withTenant(w.tenantId, (tx) => findExpiringQualifications(tx, w.tenantId));
    expect(byDefault.map((row) => row.qualificationId)).not.toContain(rows.far.id);
    await withTenant(w.tenantId, (tx) => tx.operationsSettings.create({ data: { tenantId: w.tenantId, qualificationWarningDays: 200 } }));
    const widened = await withTenant(w.tenantId, (tx) => findExpiringQualifications(tx, w.tenantId));
    expect(widened.map((row) => row.qualificationId)).toContain(rows.far.id);
    const withExpired = await withTenant(w.tenantId, (tx) => findExpiringQualifications(tx, w.tenantId, { includeExpired: true }));
    expect(withExpired.map((row) => row.qualificationId)).toContain(rows.expired.id);

    // API: HR sees everyone; a City A manager only City A.
    const cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
    const hrList = await call(listExpiring, "GET", "/x", { cookie: hr, query: { withinDays: "30" } });
    expect(hrList.json.data.map((row: { qualificationId: string }) => row.qualificationId)).toEqual(expect.arrayContaining([rows.soon.id, rows.today.id]));
    const managerList = await call(listExpiring, "GET", "/x", { cookie: cityManagerA, query: { withinDays: "30" } });
    const managerIds = managerList.json.data.map((row: { qualificationId: string }) => row.qualificationId);
    expect(managerIds).toContain(rows.soon.id);
    expect(managerIds).not.toContain(rows.today.id); // City B
    expect((await call(listExpiring, "GET", "/x", { cookie: hr, query: { withinDays: "0" } })).status).toBe(400);
  });
});

describe("no performance data in eligibility (spec 10.3)", () => {
  it("the eligibility rules and loader never reference performance, ratings, scores or workload", () => {
    const root = path.resolve(__dirname, "../..");
    const files = [
      ...readdirSync(path.join(root, "src/lib/eligibility")).map((name) => path.join(root, "src/lib/eligibility", name)),
      path.join(root, "src/server/qualifications/eligibility.ts"),
      path.join(root, "src/server/qualifications/eligibility-check.ts"),
    ];
    for (const file of files) {
      const stripped = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(stripped, file).not.toMatch(/performance|rating|score|workload|productivity/i);
    }
  });
});
