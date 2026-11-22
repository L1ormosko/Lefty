import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listQualifications, POST as createQualification } from "@/app/api/v1/qualifications/route";
import { GET as getQualification, PATCH as patchQualification } from "@/app/api/v1/qualifications/[id]/route";
import { POST as verify } from "@/app/api/v1/qualifications/[id]/verify/route";
import { POST as reject } from "@/app/api/v1/qualifications/[id]/reject/route";
import { POST as revoke } from "@/app/api/v1/qualifications/[id]/revoke/route";
import { GET as listSkills, POST as createSkill } from "@/app/api/v1/qualifications/skills/route";
import { PATCH as patchSkill } from "@/app/api/v1/qualifications/skills/[id]/route";
import { GET as listCertifications, POST as createCertification } from "@/app/api/v1/qualifications/certifications/route";
import { PATCH as patchCertification } from "@/app/api/v1/qualifications/certifications/[id]/route";
import { GET as listTerritories, POST as createTerritory } from "@/app/api/v1/qualifications/territories/route";
import { POST as endTerritory } from "@/app/api/v1/qualifications/territories/[id]/end/route";
import { GET as listJobPermissions, POST as grantJobPermission } from "@/app/api/v1/qualifications/job-permissions/route";
import { POST as endJobPermission } from "@/app/api/v1/qualifications/job-permissions/[id]/end/route";
import { GET as listAvailability, POST as createAvailability } from "@/app/api/v1/qualifications/availability/route";
import { DELETE as deleteAvailability } from "@/app/api/v1/qualifications/availability/[id]/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let hr: string;
let ceo: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;
let hrWithEmployee: { cookie: string; employeeId: string };

const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await buildWorld("quals");
  hr = await sessionCookie(w.hr, w.tenantId);
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);

  // An approver who is also an employee, to prove nobody verifies their own record.
  const roleId = await makeRole(w.tenantId, "self approver", [
    { permission: "qualifications.approve" },
    { permission: "qualifications.create" },
    { permission: "qualifications.view" },
  ]);
  const person = await createPerson(w.tenantId, "self-approver", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, person, roleId, [{ type: "TENANT" }]);
  hrWithEmployee = { cookie: await sessionCookie(person, w.tenantId), employeeId: person.employeeId as string };
});
afterAll(disconnect);

async function newSkill(name = unique("skill")) {
  const result = await call(createSkill, "POST", "/x", { cookie: hr, body: { code: name.toLowerCase(), name } });
  expect(result.status).toBe(201);
  return result.json.data as { id: string; code: string };
}
async function newCertification(extra: Record<string, unknown> = {}) {
  const code = unique("cert").toLowerCase();
  const result = await call(createCertification, "POST", "/x", { cookie: hr, body: { code, name: code, type: "LICENSE", ...extra } });
  expect(result.status).toBe(201);
  return result.json.data as { id: string; code: string; type: string };
}
const record = (cookie: string, body: Record<string, unknown>) => call(createQualification, "POST", "/x", { cookie, body });
const verifyQualification = (cookie: string, id: string) => call(verify, "POST", "/x", { cookie, params: { id } });

describe("catalogs", () => {
  it("HR creates skills and credentials; managers can read but not change the catalog; duplicate codes conflict", async () => {
    const skill = await newSkill();
    const cert = await newCertification({ requiresNumber: true });
    expect(cert.type).toBe("LICENSE");

    expect((await call(createSkill, "POST", "/x", { cookie: cityManagerA, body: { code: unique("s").toLowerCase(), name: "X" } })).status).toBe(403);
    expect((await call(createSkill, "POST", "/x", { cookie: hr, body: { code: skill.code, name: "dup" } })).status).toBe(409);
    expect((await call(createSkill, "POST", "/x", { cookie: hr, body: { code: "Bad Code", name: "x" } })).status).toBe(400);
    expect((await call(createCertification, "POST", "/x", { cookie: hr, body: { code: unique("c").toLowerCase(), name: "c", type: "SKILL" } })).status).toBe(400);

    const listed = await call(listSkills, "GET", "/x", { cookie: cityManagerA });
    expect(listed.status).toBe(200);
    expect(listed.json.data.map((row: { id: string }) => row.id)).toContain(skill.id);
    const certs = await call(listCertifications, "GET", "/x", { cookie: dispatcher, query: { type: "LICENSE" } });
    expect(certs.json.data.map((row: { id: string }) => row.id)).toContain(cert.id);

    const retired = await call(patchSkill, "PATCH", "/x", { cookie: hr, params: { id: skill.id }, body: { active: false } });
    expect(retired.json.data.active).toBe(false);
    expect((await call(patchSkill, "PATCH", "/x", { cookie: cityManagerA, params: { id: skill.id }, body: { active: true } })).status).toBe(403);
    expect((await call(patchCertification, "PATCH", "/x", { cookie: hr, params: { id: cert.id }, body: { type: "LICENSE" } })).status).toBe(400); // type is fixed
    expect((await auditEvents(w.tenantId, "skill.update", skill.id)).length).toBe(1);
  });
});

describe("recording and verifying qualifications", () => {
  it("a manager records a credential in their scope; it starts pending, kind comes from the catalog, and it is audited", async () => {
    const cert = await newCertification({ requiresNumber: true });
    const noNumber = await record(cityManagerA, { employeeId: w.techA1.employeeId, certificationId: cert.id });
    expect(noNumber.status).toBe(400);
    expect(noNumber.json.error.field).toBe("number");

    const created = await record(cityManagerA, { employeeId: w.techA1.employeeId, certificationId: cert.id, number: "L-1", expiresAt: daysFromNow(200) });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ kind: "LICENSE", status: "PENDING_VERIFICATION", number: "\u2022\u2022\u2022\u2022", verifiedById: null });
    const [event] = await auditEvents(w.tenantId, "qualification.create", created.json.data.id);
    expect(event.actorUserId).toBe(w.cityManagerA.userId);
  });

  it("refuses employees outside the caller's scope (404), callers without create (403), bad input (400) and duplicates (409)", async () => {
    const skill = await newSkill();
    expect((await record(cityManagerA, { employeeId: w.techB.employeeId, skillId: skill.id, level: 3 })).status).toBe(404);
    expect((await record(dispatcher, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 3 })).status).toBe(403);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, certificationId: skill.id })).status).toBe(400);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 9 })).status).toBe(400);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: "nope", level: 3 })).status).toBe(400);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 3, salary: 5 })).status).toBe(400);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 3 })).status).toBe(201);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 4 })).status).toBe(409);

    const retired = await newSkill();
    await call(patchSkill, "PATCH", "/x", { cookie: hr, params: { id: retired.id }, body: { active: false } });
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: retired.id })).status).toBe(400);
  });

  it("only HR verifies: managers cannot, a pending record becomes VERIFIED with verifier and time, and not twice", async () => {
    const skill = await newSkill();
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 4 })).json.data;
    expect((await verifyQualification(cityManagerA, created.id)).status).toBe(403);
    const verified = await verifyQualification(hr, created.id);
    expect(verified.status).toBe(200);
    expect(verified.json.data).toMatchObject({ status: "VERIFIED", verifiedById: w.hr.userId });
    expect(verified.json.data.verifiedAt).toBeTruthy();
    expect((await verifyQualification(hr, created.id)).status).toBe(409);
    expect((await auditEvents(w.tenantId, "qualification.verify", created.id)).length).toBe(1);
  });

  it("nobody verifies their own qualification (separation of duties)", async () => {
    const skill = await newSkill();
    const own = await record(hrWithEmployee.cookie, { employeeId: hrWithEmployee.employeeId, skillId: skill.id, level: 5 });
    expect(own.status).toBe(201);
    expect((await verifyQualification(hrWithEmployee.cookie, own.json.data.id)).status).toBe(403);
    expect((await verifyQualification(hr, own.json.data.id)).status).toBe(200);
  });

  it("verification needs the credential number and an unexpired date", async () => {
    const cert = await newCertification({ requiresNumber: true });
    const expired = await record(ceo, { employeeId: w.techA1.employeeId, certificationId: cert.id, number: "X", issuedAt: "2020-01-01", expiresAt: "2021-01-01" });
    expect((await verifyQualification(hr, expired.json.data.id)).status).toBe(400);
  });

  it("a material edit of a verified record returns it to verification; editing notes does not", async () => {
    const skill = await newSkill();
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 2 })).json.data;
    await verifyQualification(hr, created.id);

    const notes = await call(patchQualification, "PATCH", "/x", { cookie: cityManagerA, params: { id: created.id }, body: { notes: "taught by Sam" } });
    expect(notes.json.data.status).toBe("VERIFIED");

    const levelUp = await call(patchQualification, "PATCH", "/x", { cookie: cityManagerA, params: { id: created.id }, body: { level: 5 } });
    expect(levelUp.status).toBe(200);
    expect(levelUp.json.data).toMatchObject({ level: 5, status: "PENDING_VERIFICATION", verifiedById: null, verifiedAt: null });
    const [event] = await auditEvents(w.tenantId, "qualification.update", created.id);
    expect(event.newValue).toMatchObject({ level: 5, status: "PENDING_VERIFICATION" });
    expect((await call(patchQualification, "PATCH", "/x", { cookie: dispatcher, params: { id: created.id }, body: { level: 1 } })).status).toBe(403);
    expect((await call(patchQualification, "PATCH", "/x", { cookie: cityManagerA, params: { id: created.id }, body: {} })).status).toBe(400);
  });

  it("rejecting and revoking need a reason and follow the status machine; an edit resubmits", async () => {
    const skill = await newSkill();
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 3 })).json.data;
    expect((await call(reject, "POST", "/x", { cookie: hr, params: { id: created.id }, body: {} })).status).toBe(400);
    expect((await call(revoke, "POST", "/x", { cookie: hr, params: { id: created.id }, body: { reason: "r" } })).status).toBe(409); // not verified yet
    const rejected = await call(reject, "POST", "/x", { cookie: hr, params: { id: created.id }, body: { reason: "Photo unreadable" } });
    expect(rejected.json.data.status).toBe("REJECTED");
    expect((await auditEvents(w.tenantId, "qualification.reject", created.id))[0].reason).toBe("Photo unreadable");
    expect((await verifyQualification(hr, created.id)).status).toBe(409);

    const resubmitted = await call(patchQualification, "PATCH", "/x", { cookie: cityManagerA, params: { id: created.id }, body: { notes: "new photo" } });
    expect(resubmitted.json.data.status).toBe("PENDING_VERIFICATION");
    await verifyQualification(hr, created.id);
    const revoked = await call(revoke, "POST", "/x", { cookie: hr, params: { id: created.id }, body: { reason: "Withdrawn by authority" } });
    expect(revoked.json.data).toMatchObject({ status: "REVOKED", verifiedById: null });
  });
});

describe("reading and scope", () => {
  it("a technician sees only their own records (OWN scope); managers see their subtree; other tenants see nothing", async () => {
    const skill = await newSkill();
    const own = (await record(cityManagerA, { employeeId: w.techA1.employeeId, skillId: skill.id, level: 3 })).json.data;
    const other = (await record(cityManagerB, { employeeId: w.techB.employeeId, skillId: skill.id, level: 3 })).json.data;

    const mine = await call(listQualifications, "GET", "/x", { cookie: techA1, query: { skillId: skill.id } });
    expect(mine.json.data.map((row: { id: string }) => row.id)).toEqual([own.id]);
    expect((await call(getQualification, "GET", "/x", { cookie: techA1, params: { id: other.id } })).status).toBe(404);
    expect((await call(getQualification, "GET", "/x", { cookie: techA1, params: { id: own.id } })).status).toBe(200);

    const managerA = await call(listQualifications, "GET", "/x", { cookie: cityManagerA, query: { skillId: skill.id } });
    expect(managerA.json.data.map((row: { id: string }) => row.id)).toEqual([own.id]);
    const everything = await call(listQualifications, "GET", "/x", { cookie: hr, query: { skillId: skill.id } });
    expect(everything.json.data.map((row: { id: string }) => row.id).sort()).toEqual([own.id, other.id].sort());

    const foreign = await buildWorld("quals-other");
    const foreignHr = await sessionCookie(foreign.hr, foreign.tenantId);
    expect((await call(getQualification, "GET", "/x", { cookie: foreignHr, params: { id: own.id } })).status).toBe(404);
    expect((await call(listQualifications, "GET", "/x", { cookie: foreignHr, query: { skillId: skill.id } })).json.data).toEqual([]);
    expect((await record(foreignHr, { employeeId: w.techA1.employeeId, skillId: skill.id })).status).toBe(404);
  });

  it("a terminated employee's records cannot be changed", async () => {
    const skill = await newSkill();
    const person = await createPerson(w.tenantId, "leaver", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: person.employeeId as string }, data: { status: "TERMINATED", terminationDate: new Date("2026-01-01T00:00:00Z") } }));
    expect((await record(hr, { employeeId: person.employeeId, skillId: skill.id })).status).toBe(409);
  });
});

describe("territories", () => {
  it("a manager adds territories inside their own scope only, can end them, and re-adding reopens the row", async () => {
    const outsideUnit = await call(createTerritory, "POST", "/x", { cookie: cityManagerA, body: { employeeId: w.techA1.employeeId, orgUnitId: w.units.cityB } });
    expect(outsideUnit.status).toBe(404); // the manager has no authority over City B
    const outsideEmployee = await call(createTerritory, "POST", "/x", { cookie: cityManagerA, body: { employeeId: w.techB.employeeId, orgUnitId: w.units.cityA } });
    expect(outsideEmployee.status).toBe(404);

    const added = await call(createTerritory, "POST", "/x", { cookie: cityManagerA, body: { employeeId: w.techA1Other.employeeId, orgUnitId: w.units.cityA } });
    expect(added.status).toBe(201);
    expect(added.json.data).toMatchObject({ includeDescendants: true, effectiveTo: null });
    expect((await call(createTerritory, "POST", "/x", { cookie: cityManagerA, body: { employeeId: w.techA1Other.employeeId, orgUnitId: w.units.cityA } })).status).toBe(409);

    const ended = await call(endTerritory, "POST", "/x", { cookie: cityManagerA, params: { id: added.json.data.id }, body: { reason: "moved" } });
    expect(ended.json.data.effectiveTo).toBeTruthy();
    expect((await call(endTerritory, "POST", "/x", { cookie: cityManagerA, params: { id: added.json.data.id }, body: {} })).status).toBe(409);

    const listedActive = await call(listTerritories, "GET", "/x", { cookie: cityManagerA, query: { employeeId: w.techA1Other.employeeId as string, activeOnly: "true" } });
    expect(listedActive.json.data).toEqual([]);
    const reopened = await call(createTerritory, "POST", "/x", { cookie: cityManagerA, body: { employeeId: w.techA1Other.employeeId, orgUnitId: w.units.cityA, includeDescendants: false } });
    expect(reopened.status).toBe(201);
    expect(reopened.json.data).toMatchObject({ id: added.json.data.id, includeDescendants: false, effectiveTo: null });
    expect((await auditEvents(w.tenantId, "service_territory.add", added.json.data.id)).length).toBe(2);
  });
});

describe("job-category permissions", () => {
  it("HR grants and ends them; managers (who only edit) cannot; exactly one of job type / category", async () => {
    const body = { employeeId: w.techA1.employeeId, category: unique("repair"), reason: "Passed the practical" };
    expect((await call(grantJobPermission, "POST", "/x", { cookie: cityManagerA, body })).status).toBe(403);
    expect((await call(grantJobPermission, "POST", "/x", { cookie: hr, body: { employeeId: w.techA1.employeeId } })).status).toBe(400);
    expect((await call(grantJobPermission, "POST", "/x", { cookie: hr, body: { ...body, jobTypeId: "x" } })).status).toBe(400);
    expect((await call(grantJobPermission, "POST", "/x", { cookie: hr, body: { ...body, jobTypeId: undefined, category: undefined } })).status).toBe(400);
    expect((await call(grantJobPermission, "POST", "/x", { cookie: hr, body: { employeeId: w.techA1.employeeId, jobTypeId: "missing" } })).status).toBe(400);

    const granted = await call(grantJobPermission, "POST", "/x", { cookie: hr, body });
    expect(granted.status).toBe(201);
    expect(granted.json.data).toMatchObject({ category: body.category, grantedById: w.hr.userId, jobTypeId: null });

    const listed = await call(listJobPermissions, "GET", "/x", { cookie: cityManagerA, query: { employeeId: w.techA1.employeeId as string, activeOnly: "true" } });
    expect(listed.json.data.map((row: { id: string }) => row.id)).toContain(granted.json.data.id);
    expect((await call(endJobPermission, "POST", "/x", { cookie: cityManagerA, params: { id: granted.json.data.id }, body: {} })).status).toBe(403);
    const ended = await call(endJobPermission, "POST", "/x", { cookie: hr, params: { id: granted.json.data.id }, body: {} });
    expect(ended.json.data.effectiveTo).toBeTruthy();
    expect((await call(endJobPermission, "POST", "/x", { cookie: hr, params: { id: granted.json.data.id }, body: {} })).status).toBe(409);
  });
});

describe("availability", () => {
  it("creates weekly windows and exceptions in the right time zone and rejects windows that cross midnight", async () => {
    const employeeId = w.techA1.employeeId;
    // The branch unit's zone beats the company default.
    await withTenant(w.tenantId, (tx) => tx.orgUnit.update({ where: { id: w.units.cityA }, data: { timeZone: "America/Chicago" } }));
    const weekly = await call(createAvailability, "POST", "/x", {
      cookie: cityManagerA,
      body: { kind: "WEEKLY_WINDOW", employeeId, isoDayOfWeek: 1, startMinute: 540, endMinute: 1020 },
    });
    expect(weekly.status).toBe(201);
    expect(weekly.json.data).toMatchObject({ timeZone: "America/Chicago", isoDayOfWeek: 1, startMinute: 540, endMinute: 1020, startsAt: null });

    const explicit = await call(createAvailability, "POST", "/x", {
      cookie: cityManagerA,
      body: { kind: "WEEKLY_WINDOW", employeeId, isoDayOfWeek: 2, startMinute: 0, endMinute: 1440, timeZone: "Europe/London" },
    });
    expect(explicit.json.data.timeZone).toBe("Europe/London");

    const timeOff = await call(createAvailability, "POST", "/x", {
      cookie: cityManagerA,
      body: { kind: "EXCEPTION_UNAVAILABLE", employeeId, startsAt: "2026-12-24T14:00:00Z", endsAt: "2026-12-26T14:00:00Z", note: "holiday" },
    });
    expect(timeOff.status).toBe(201);
    expect(timeOff.json.data).toMatchObject({ kind: "EXCEPTION_UNAVAILABLE", isoDayOfWeek: null, startMinute: null });

    const bad = (body: Record<string, unknown>) => call(createAvailability, "POST", "/x", { cookie: cityManagerA, body: { employeeId, ...body } });
    expect((await bad({ kind: "WEEKLY_WINDOW", isoDayOfWeek: 1, startMinute: 1320, endMinute: 360 })).status).toBe(400); // crosses midnight
    expect((await bad({ kind: "WEEKLY_WINDOW", isoDayOfWeek: 8, startMinute: 0, endMinute: 60 })).status).toBe(400);
    expect((await bad({ kind: "WEEKLY_WINDOW", isoDayOfWeek: 1, startMinute: 0, endMinute: 60, timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await bad({ kind: "EXCEPTION_UNAVAILABLE", startsAt: "2026-12-26T14:00:00Z", endsAt: "2026-12-24T14:00:00Z" })).status).toBe(400);
    expect((await bad({ kind: "EXCEPTION_UNAVAILABLE", startsAt: "2026-12-24T14:00:00Z" })).status).toBe(400);
    expect((await call(createAvailability, "POST", "/x", { cookie: cityManagerB, body: { kind: "WEEKLY_WINDOW", employeeId, isoDayOfWeek: 1, startMinute: 0, endMinute: 60 } })).status).toBe(404);

    const listed = await call(listAvailability, "GET", "/x", { cookie: dispatcher, query: { employeeId: employeeId as string } });
    expect(listed.status).toBe(200);
    expect(listed.json.data.length).toBeGreaterThanOrEqual(3);
    expect((await call(listAvailability, "GET", "/x", { cookie: cityManagerB, query: { employeeId: employeeId as string } })).status).toBe(404);

    expect((await call(deleteAvailability, "DELETE", "/x", { cookie: cityManagerB, params: { id: timeOff.json.data.id } })).status).toBe(404);
    expect((await call(deleteAvailability, "DELETE", "/x", { cookie: cityManagerA, params: { id: timeOff.json.data.id } })).status).toBe(204);
    expect((await call(deleteAvailability, "DELETE", "/x", { cookie: cityManagerA, params: { id: timeOff.json.data.id } })).status).toBe(404);
    const [event] = await auditEvents(w.tenantId, "availability.delete", timeOff.json.data.id);
    expect(event.previousValue).toMatchObject({ kind: "EXCEPTION_UNAVAILABLE", note: "holiday" });
  });
});

describe("private fields: credential numbers and availability notes", () => {
  const FULL = "ABC-123456";
  const MASKED = "••••3456";

  it("shows the number in full only to the holder and approvers; keeps it out of the audit log in clear", async () => {
    const cert = await newCertification();
    const created = await record(cityManagerA, { employeeId: w.techA1.employeeId, certificationId: cert.id, number: FULL, expiresAt: daysFromNow(300) });
    expect(created.json.data.number).toBe(MASKED); // a manager (edit/create, no approve) never gets it back
    const id = created.json.data.id;

    const read = (cookie: string) => call(getQualification, "GET", "/x", { cookie, params: { id } });
    expect((await read(cityManagerA)).json.data.number).toBe(MASKED);
    expect((await read(dispatcher)).json.data.number).toBe(MASKED);
    expect((await read(hr)).json.data.number).toBe(FULL);
    expect((await read(techA1)).json.data.number).toBe(FULL); // the holder
    const asList = (cookie: string) => call(listQualifications, "GET", "/x", { cookie, query: { certificationId: cert.id } });
    expect((await asList(cityManagerA)).json.data[0].number).toBe(MASKED);
    expect((await asList(hr)).json.data[0].number).toBe(FULL);

    const changed = await call(patchQualification, "PATCH", "/x", { cookie: cityManagerA, params: { id }, body: { number: "ZZZ-987654" } });
    expect(changed.json.data.number).toBe("••••7654");
    const verified = await verifyQualification(hr, id);
    expect(verified.json.data.number).toBe("ZZZ-987654");

    const events = [...(await auditEvents(w.tenantId, "qualification.create", id)), ...(await auditEvents(w.tenantId, "qualification.update", id))];
    expect(events.length).toBe(2);
    const serialized = JSON.stringify(events.map((event) => [event.previousValue, event.newValue]));
    for (const secret of [FULL, "ZZZ-987654", "123456", "987654"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("3456");
  });

  it("availability notes are shown to the holder and approvers only", async () => {
    const created = await call(createAvailability, "POST", "/x", {
      cookie: cityManagerA,
      body: { kind: "EXCEPTION_UNAVAILABLE", employeeId: w.techA1Other.employeeId, startsAt: "2027-01-10T00:00:00Z", endsAt: "2027-01-11T00:00:00Z", note: "surgery" },
    });
    expect(created.json.data.note).toBeNull();
    const list = (cookie: string) => call(listAvailability, "GET", "/x", { cookie, query: { employeeId: w.techA1Other.employeeId as string } });
    expect((await list(cityManagerA)).json.data[0].note).toBeNull();
    expect((await list(dispatcher)).json.data[0].note).toBeNull();
    expect((await list(hr)).json.data[0].note).toBe("surgery");
  });
});
