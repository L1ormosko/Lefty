import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listEmployees, POST as createEmployee } from "@/app/api/v1/employees/route";
import { GET as getEmployee, PATCH as patchEmployee } from "@/app/api/v1/employees/[id]/route";
import { POST as terminate } from "@/app/api/v1/employees/[id]/terminate/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let ceo: string;
let cityManagerA: string;
let dispatcher: string;
let hr: string;

beforeAll(async () => {
  w = await buildWorld("employees");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  hr = await sessionCookie(w.hr, w.tenantId);
});
afterAll(disconnect);

const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;
const create = (cookie: string, body: Record<string, unknown>) => call(createEmployee, "POST", "/api/v1/employees", { cookie, body });
const person = (extra: Record<string, unknown> = {}) => ({ firstName: unique("First"), lastName: unique("Last"), ...extra });

describe("employee creation", () => {
  it("creates an employee with an initial PRIMARY placement and audits it", async () => {
    const result = await create(cityManagerA, person({ orgUnitId: w.units.cityA, jobTitle: "Installer", hireDate: "2026-01-15", email: "New.Hire@Example.Test" }));
    expect(result.status).toBe(201);
    const employee = result.json.data;
    expect(employee).toMatchObject({ jobTitle: "Installer", email: "new.hire@example.test", status: "ACTIVE", currentOrgUnitIds: [w.units.cityA] });
    // Date-only fields are calendar dates (YYYY-MM-DD); timestamps stay ISO datetimes.
    expect(employee.hireDate).toBe("2026-01-15");
    expect(employee.terminationDate).toBeNull();
    expect(employee.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const placements = await withTenant(w.tenantId, (tx) => tx.organizationalAssignment.findMany({ where: { employeeId: employee.id } }));
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ kind: "PRIMARY", orgUnitId: w.units.cityA, createdById: w.cityManagerA.userId });
    const [event] = await auditEvents(w.tenantId, "employee.create", employee.id);
    expect(event.actorUserId).toBe(w.cityManagerA.userId);
  });

  it("refuses placement outside the creator's scope (404) or an unplaced employee without a tenant-wide grant (403)", async () => {
    expect((await create(cityManagerA, person({ orgUnitId: w.units.cityB }))).status).toBe(404);
    expect((await create(cityManagerA, person())).status).toBe(403);
    expect((await create(hr, person())).status).toBe(201); // HR holds a tenant-wide employees.create
  });

  it("rejects an archived unit, an archived legal entity and bad input", async () => {
    const archived = await withTenant(w.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "CITY", name: unique("Closed"), parentId: w.units.state, active: false } }),
    );
    expect((await create(ceo, person({ orgUnitId: archived.id }))).status).toBe(409);
    expect((await create(ceo, person({ legalEntityId: "nope" }))).status).toBe(400);
    expect((await create(ceo, { firstName: "", lastName: "x" })).status).toBe(400);
    expect((await create(ceo, person({ hireDate: "2026-02-31" }))).status).toBe(400);
    expect((await create(ceo, person({ salary: 100000 }))).status).toBe(400); // unknown field
  });

  it("a duplicate employee number is a 409, not a 500", async () => {
    const employeeNumber = unique("N-");
    expect((await create(ceo, person({ employeeNumber, orgUnitId: w.units.cityA }))).status).toBe(201);
    const again = await create(ceo, person({ employeeNumber, orgUnitId: w.units.cityA }));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("CONFLICT");
  });

  it("a grant limited to another field set may not create or edit records (dispatcher/finance style)", async () => {
    const roleId = await makeRole(w.tenantId, "financial editor", [{ permission: "employees.edit", conditions: { fields: "financial" } }, { permission: "employees.create", conditions: { fields: "financial" } }]);
    const limited = await createPerson(w.tenantId, "limited", { withEmployee: false });
    await grantTemplate(w.tenantId, limited, roleId, [{ type: "TENANT" }]);
    const cookie = await sessionCookie(limited, w.tenantId);
    expect((await create(cookie, person({ orgUnitId: w.units.cityA }))).status).toBe(403);
    expect((await call(patchEmployee, "PATCH", "/x", { cookie, params: { id: w.techA1.employeeId! }, body: { jobTitle: "Boss" } })).status).toBe(403);
  });
});

describe("employee read, update and list", () => {
  it("projects fields per grant: a dispatcher's availability-only grant returns no base fields", async () => {
    const asManager = await call(getEmployee, "GET", "/x", { cookie: cityManagerA, params: { id: w.techA1.employeeId! } });
    expect(asManager.status).toBe(200);
    expect(asManager.json.data).toMatchObject({ id: w.techA1.employeeId, firstName: "tech-a1" });
    expect(asManager.json.data.salary).toBeUndefined();

    const asDispatcher = await call(getEmployee, "GET", "/x", { cookie: dispatcher, params: { id: w.techA1.employeeId! } });
    expect(asDispatcher.status).toBe(200);
    expect(asDispatcher.json.data.firstName).toBeUndefined();
    expect(asDispatcher.json.data.email).toBeUndefined();
  });

  it("scope-filters the list: a city manager sees their city's people and not City B's", async () => {
    const mine = await call(listEmployees, "GET", "/api/v1/employees", { cookie: cityManagerA, query: { limit: "200" } });
    const ids = mine.json.data.map((employee: { id: string }) => employee.id);
    expect(ids).toContain(w.techA1.employeeId);
    expect(ids).toContain(w.cityManagerA.employeeId);
    expect(ids).not.toContain(w.techB.employeeId);
    expect(ids).not.toContain(w.cityManagerB.employeeId);
    // every row is projected (financial keys never appear)
    expect(mine.json.data.every((row: Record<string, unknown>) => row.salary === undefined && row.payRate === undefined)).toBe(true);
  });

  it("a technician (OWN scope) lists only themselves", async () => {
    const cookie = await sessionCookie(w.techA1, w.tenantId);
    const result = await call(listEmployees, "GET", "/x", { cookie });
    expect(result.json.data.map((row: { id: string }) => row.id)).toEqual([w.techA1.employeeId]);
  });

  it("filters by org unit and paginates without gaps", async () => {
    const inTeam = await call(listEmployees, "GET", "/x", { cookie: ceo, query: { orgUnitId: w.units.teamA1, limit: "1" } });
    expect(inTeam.json.data).toHaveLength(1);
    expect(inTeam.json.page.nextCursor).toBeTruthy();
    const next = await call(listEmployees, "GET", "/x", { cookie: ceo, query: { orgUnitId: w.units.teamA1, limit: "1", cursor: inTeam.json.page.nextCursor } });
    expect(next.json.data).toHaveLength(1);
    expect(next.json.data[0].id).not.toBe(inTeam.json.data[0].id);
  });

  it("updates data, audits only changed fields, and toggles ON_LEAVE", async () => {
    const created = (await create(ceo, person({ orgUnitId: w.units.cityA, jobTitle: "Before" }))).json.data;
    const result = await call(patchEmployee, "PATCH", "/x", { cookie: ceo, params: { id: created.id }, body: { jobTitle: "After", status: "ON_LEAVE" } });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ jobTitle: "After", status: "ON_LEAVE" });
    const [event] = await auditEvents(w.tenantId, "employee.update", created.id);
    expect(event.previousValue).toEqual({ jobTitle: "Before", status: "ACTIVE" });
    expect(event.newValue).toEqual({ jobTitle: "After", status: "ON_LEAVE" });
  });

  it("cannot read or change an employee of another tenant or outside scope (404)", async () => {
    const other = await buildWorld("employees-other");
    expect((await call(getEmployee, "GET", "/x", { cookie: ceo, params: { id: other.techA1.employeeId! } })).status).toBe(404);
    expect((await call(patchEmployee, "PATCH", "/x", { cookie: ceo, params: { id: other.techA1.employeeId! }, body: { jobTitle: "X" } })).status).toBe(404);
    expect((await call(patchEmployee, "PATCH", "/x", { cookie: cityManagerA, params: { id: w.techB.employeeId! }, body: { jobTitle: "X" } })).status).toBe(404);
    const stillSame = await withTenant(other.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: other.techA1.employeeId! } }));
    expect(stillSame.jobTitle).toBeNull();
  });
});

describe("terminating an employee", () => {
  it("ends employment softly: status, placements, manager roles, login and sessions", async () => {
    const worker = await createPerson(w.tenantId, "leaver", { orgUnitId: w.units.cityA });
    await withTenant(w.tenantId, (tx) =>
      tx.orgUnitManager.create({ data: { tenantId: w.tenantId, orgUnitId: w.units.cityA, employeeId: worker.employeeId!, effectiveFrom: new Date(Date.now() - 86_400_000) } }),
    );
    const workerCookie = await sessionCookie(worker, w.tenantId);

    const result = await call(terminate, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "Resigned" } });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ status: "TERMINATED", terminationDate: "2026-11-01", currentOrgUnitIds: [] });

    await withTenant(w.tenantId, async (tx) => {
      const placements = await tx.organizationalAssignment.findMany({ where: { employeeId: worker.employeeId! } });
      expect(placements).toHaveLength(1); // history kept
      expect(placements[0].effectiveTo).not.toBeNull();
      const managers = await tx.orgUnitManager.findMany({ where: { employeeId: worker.employeeId! } });
      expect(managers.every((row) => row.effectiveTo !== null)).toBe(true);
      expect((await tx.user.findUniqueOrThrow({ where: { id: worker.userId } })).status).toBe("DEACTIVATED");
      const sessions = await tx.session.findMany({ where: { userId: worker.userId } });
      expect(sessions.every((row) => row.revokedAt !== null)).toBe(true);
    });
    // the revoked session no longer authenticates
    expect((await call(listEmployees, "GET", "/x", { cookie: workerCookie })).status).toBe(401);

    const [event] = await auditEvents(w.tenantId, "employee.terminate", worker.employeeId!);
    expect(event).toMatchObject({ reason: "Resigned", actorUserId: w.ceo.userId });
    // terminated = read-only
    expect((await call(patchEmployee, "PATCH", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { jobTitle: "Zombie" } })).status).toBe(409);
    expect((await call(terminate, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-02", reason: "again" } })).status).toBe(409);
  });

  it("revokes the employee's open invitations in the same transaction, leaving accepted ones alone", async () => {
    const worker = await createPerson(w.tenantId, "invitee-leaver", { orgUnitId: w.units.cityA });
    const invitation = (tokenHash: string, extra: object = {}) =>
      withTenant(w.tenantId, (tx) =>
        tx.invitation.create({
          data: { tenantId: w.tenantId, email: `${tokenHash}@example.test`, tokenHash, employeeId: worker.employeeId!, expiresAt: new Date(Date.now() + 86_400_000), ...extra },
        }),
      );
    const open = await invitation(`open-${Date.now()}-${Math.random()}`);
    const accepted = await invitation(`accepted-${Date.now()}-${Math.random()}`, { acceptedAt: new Date() });

    expect((await call(terminate, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "left" } })).status).toBe(200);

    const rows = await withTenant(w.tenantId, (tx) => tx.invitation.findMany({ where: { id: { in: [open.id, accepted.id] } } }));
    expect(rows.find((row) => row.id === open.id)?.revokedAt).not.toBeNull();
    expect(rows.find((row) => row.id === accepted.id)?.revokedAt).toBeNull();
    const [event] = await auditEvents(w.tenantId, "employee.terminate", worker.employeeId!);
    expect(event.newValue).toMatchObject({ revokedInvitations: 1 });
  });

  it("rejects a future termination date, requires a reason, and respects scope and permission", async () => {
    const worker = await createPerson(w.tenantId, "stayer", { orgUnitId: w.units.cityA });
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await call(terminate, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { terminationDate: future, reason: "x" } })).status).toBe(400);
    expect((await call(terminate, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01" } })).status).toBe(400);
    // a city manager has no employees.archive
    expect((await call(terminate, "POST", "/x", { cookie: cityManagerA, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } })).status).toBe(403);
    // HR (tenant-wide employees.archive) may
    expect((await call(terminate, "POST", "/x", { cookie: hr, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } })).status).toBe(200);
  });
});

describe("legal employer is part of the data scope", () => {
  it("a unit-scoped manager cannot file a record under, or re-point it to, a legal entity outside their scope", async () => {
    const created = await create(cityManagerA, person({ orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId }));
    expect(created.status).toBe(404);

    const own = (await create(cityManagerA, person({ orgUnitId: w.units.cityA }))).json.data;
    const repointed = await call(patchEmployee, "PATCH", "/x", { cookie: cityManagerA, params: { id: own.id }, body: { legalEntityId: w.legalEntityId } });
    expect(repointed.status).toBe(404);
    const row = await withTenant(w.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: own.id } }));
    expect(row.legalEntityId).toBeNull();

    // a tenant-wide holder may
    expect((await create(hr, person({ orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId }))).status).toBe(201);
  });

  it("org units: creating or re-pointing a unit's legal entity needs authority over that entity", async () => {
    const { POST: createUnit } = await import("@/app/api/v1/organization/units/route");
    const { PATCH: patchUnit } = await import("@/app/api/v1/organization/units/[id]/route");
    const denied = await call(createUnit, "POST", "/x", { cookie: cityManagerA, body: { type: "TEAM", name: unique("T"), parentId: w.units.cityA, legalEntityId: w.legalEntityId } });
    expect(denied.status).toBe(404);
    const team = (await call(createUnit, "POST", "/x", { cookie: cityManagerA, body: { type: "TEAM", name: unique("T"), parentId: w.units.cityA } })).json.data;
    expect((await call(patchUnit, "PATCH", "/x", { cookie: cityManagerA, params: { id: team.id }, body: { legalEntityId: w.legalEntityId } })).status).toBe(404);
    expect((await call(patchUnit, "PATCH", "/x", { cookie: ceo, params: { id: team.id }, body: { legalEntityId: w.legalEntityId } })).status).toBe(200);
  });
});

describe("terminating people with privileged logins", () => {
  it("HR cannot terminate (and so lock out) a user who holds the Owner role, but the Owner can", async () => {
    const owner2 = await createPerson(w.tenantId, "second-owner", { orgUnitId: w.units.state });
    await grantTemplate(w.tenantId, owner2, w.roles.OWNER_CEO, [{ type: "TENANT" }]);
    const attempt = await call(terminate, "POST", "/x", { cookie: hr, params: { id: owner2.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } });
    expect(attempt.status).toBe(403);
    await withTenant(w.tenantId, async (tx) => {
      expect((await tx.employee.findUniqueOrThrow({ where: { id: owner2.employeeId! } })).status).toBe("ACTIVE");
      expect((await tx.user.findUniqueOrThrow({ where: { id: owner2.userId } })).status).toBe("ACTIVE");
    });
    expect((await call(terminate, "POST", "/x", { cookie: ceo, params: { id: owner2.employeeId! }, body: { terminationDate: "2026-11-01", reason: "left" } })).status).toBe(200);
  });

  it("without users.archive the employee record is terminated but the login is left for a user administrator (flagged in the audit)", async () => {
    const worker = await createPerson(w.tenantId, "hr-term", { orgUnitId: w.units.cityA });
    expect((await call(terminate, "POST", "/x", { cookie: hr, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } })).status).toBe(200);
    await withTenant(w.tenantId, async (tx) => {
      expect((await tx.employee.findUniqueOrThrow({ where: { id: worker.employeeId! } })).status).toBe("TERMINATED");
      expect((await tx.user.findUniqueOrThrow({ where: { id: worker.userId } })).status).toBe("ACTIVE");
    });
    const [event] = await auditEvents(w.tenantId, "employee.terminate", worker.employeeId!);
    expect(event.newValue).toMatchObject({ loginLeftActiveForUserAdministrator: true, deactivatedUserId: null });
  });
});

describe("termination side effects and guards (round 2)", () => {
  it("always revokes the sessions of the terminated employee, even when the login stays for a user administrator", async () => {
    const worker = await createPerson(w.tenantId, "sessions", { orgUnitId: w.units.cityA });
    const cookie = await sessionCookie(worker, w.tenantId);
    expect((await call(terminate, "POST", "/x", { cookie: hr, params: { id: worker.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } })).status).toBe(200);
    await withTenant(w.tenantId, async (tx) => {
      expect((await tx.user.findUniqueOrThrow({ where: { id: worker.userId } })).status).toBe("ACTIVE");
      expect((await tx.session.findMany({ where: { userId: worker.userId } })).every((row) => row.revokedAt !== null)).toBe(true);
    });
    expect((await call(listEmployees, "GET", "/x", { cookie })).status).toBe(401);
    const [event] = await auditEvents(w.tenantId, "employee.terminate", worker.employeeId!);
    expect((event.newValue as { revokedSessions: number }).revokedSessions).toBe(1);
  });

  it("nobody terminates their own employee record", async () => {
    const self = await createPerson(w.tenantId, "self-term", { orgUnitId: w.units.cityA });
    const role = await makeRole(w.tenantId, "self terminator", [{ permission: "employees.archive" }]);
    await grantTemplate(w.tenantId, self, role, [{ type: "TENANT" }]);
    const result = await call(terminate, "POST", "/x", { cookie: await sessionCookie(self, w.tenantId), params: { id: self.employeeId! }, body: { terminationDate: "2026-11-01", reason: "x" } });
    expect(result.status).toBe(403);
    expect((await withTenant(w.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: self.employeeId! } }))).status).toBe("ACTIVE");
  });
});
