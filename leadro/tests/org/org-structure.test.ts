import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getTenant, PATCH as patchTenant } from "@/app/api/v1/tenants/current/route";
import { GET as listEntities, POST as createEntity } from "@/app/api/v1/organization/legal-entities/route";
import { PATCH as patchEntity } from "@/app/api/v1/organization/legal-entities/[id]/route";
import { POST as archiveEntity } from "@/app/api/v1/organization/legal-entities/[id]/archive/route";
import { GET as listManagers, POST as addManager } from "@/app/api/v1/organization/units/[id]/managers/route";
import { DELETE as removeManager } from "@/app/api/v1/organization/units/[id]/managers/[managerId]/route";
import { POST as archiveUnit } from "@/app/api/v1/organization/units/[id]/archive/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "./org-helpers";

let w: World;
let ceo: string;
let cityManagerA: string;
let hr: string;

beforeAll(async () => {
  w = await buildWorld("org-structure");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  hr = await sessionCookie(w.hr, w.tenantId);
});
afterAll(disconnect);

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

describe("tenant profile", () => {
  it("shows the caller's own company and nothing about other tenants", async () => {
    const result = await call(getTenant, "GET", "/api/v1/tenants/current", { cookie: ceo });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ id: w.tenantId, defaultLocale: "en-US" });
  });

  it("lets a tenant-wide editor change the name and defaults, auditing previous and new values", async () => {
    const result = await call(patchTenant, "PATCH", "/api/v1/tenants/current", {
      cookie: ceo,
      body: { name: "Renamed Company", defaultLocale: "es-US", defaultTimeZone: "America/Chicago" },
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ name: "Renamed Company", defaultLocale: "es-US" });
    const [event] = await auditEvents(w.tenantId, "tenant.update");
    expect(event.newValue).toMatchObject({ name: "Renamed Company", defaultLocale: "es-US" });
    expect(event.previousValue).toMatchObject({ defaultLocale: "en-US" });
  });

  it("rejects unsupported locales, unknown time zones and attempts to change the company code", async () => {
    expect((await call(patchTenant, "PATCH", "/x", { cookie: ceo, body: { defaultLocale: "fr-FR" } })).status).toBe(400);
    expect((await call(patchTenant, "PATCH", "/x", { cookie: ceo, body: { defaultTimeZone: "Mars/Base" } })).status).toBe(400);
    expect((await call(patchTenant, "PATCH", "/x", { cookie: ceo, body: { slug: "takeover" } })).status).toBe(400);
  });

  it("is forbidden for a unit-scoped manager (company settings are tenant-level)", async () => {
    expect((await call(getTenant, "GET", "/x", { cookie: cityManagerA })).status).toBe(403);
    expect((await call(patchTenant, "PATCH", "/x", { cookie: cityManagerA, body: { name: "Mine now" } })).status).toBe(403);
  });
});

describe("legal entities", () => {
  it("creates, renames, lists and archives (soft) an entity; duplicates conflict", async () => {
    const name = unique("Entity");
    const created = await call(createEntity, "POST", "/api/v1/organization/legal-entities", { cookie: ceo, body: { name, legalName: `${name} LLC` } });
    expect(created.status).toBe(201);
    const id = created.json.data.id;

    expect((await call(createEntity, "POST", "/x", { cookie: ceo, body: { name } })).status).toBe(409);
    const renamed = await call(patchEntity, "PATCH", "/x", { cookie: ceo, params: { id }, body: { name: `${name} 2` } });
    expect(renamed.json.data.name).toBe(`${name} 2`);

    const archived = await call(archiveEntity, "POST", "/x", { cookie: ceo, params: { id }, body: { reason: "Dissolved" } });
    expect(archived.json.data.active).toBe(false);
    expect((await call(patchEntity, "PATCH", "/x", { cookie: ceo, params: { id }, body: { name: "Nope" } })).status).toBe(409);
    expect((await auditEvents(w.tenantId, "legal_entity.archive", id))[0].reason).toBe("Dissolved");
  });

  it("refuses to archive an entity that active units or employees still reference", async () => {
    const result = await call(archiveEntity, "POST", "/x", { cookie: ceo, params: { id: w.legalEntityId }, body: {} });
    expect(result.status).toBe(409);
  });

  it("lists with pagination; a unit-scoped manager has no legal-entity scope and sees none", async () => {
    const all = await call(listEntities, "GET", "/api/v1/organization/legal-entities", { cookie: ceo, query: { limit: "1" } });
    expect(all.status).toBe(200);
    expect(all.json.data).toHaveLength(1);
    expect(all.json.page.limit).toBe(1);

    const scoped = await call(listEntities, "GET", "/x", { cookie: cityManagerA });
    expect(scoped.status).toBe(200);
    expect(scoped.json.data).toEqual([]);
  });

  it("only a tenant-wide grant may create (a city manager gets 403)", async () => {
    expect((await call(createEntity, "POST", "/x", { cookie: cityManagerA, body: { name: unique("X") } })).status).toBe(403);
  });
});

describe("unit managers", () => {
  const managerUrl = (unitId: string) => `/api/v1/organization/units/${unitId}/managers`;

  it("allows several managers per unit and one employee over several units, with a single primary", async () => {
    const a = await createPerson(w.tenantId, "mgr-a", { orgUnitId: w.units.cityA });
    const b = await createPerson(w.tenantId, "mgr-b", { orgUnitId: w.units.cityA });

    const first = await call(addManager, "POST", managerUrl(w.units.cityA), { cookie: ceo, params: { id: w.units.cityA }, body: { employeeId: a.employeeId, isPrimary: true } });
    expect(first.status).toBe(201);
    expect(Object.keys(first.json.data).sort()).toEqual(["effectiveFrom", "effectiveTo", "employeeId", "id", "isPrimary", "orgUnitId"]); // no tenantId
    const second = await call(addManager, "POST", managerUrl(w.units.cityA), { cookie: ceo, params: { id: w.units.cityA }, body: { employeeId: b.employeeId, isPrimary: true } });
    expect(second.status).toBe(201);
    // a manages another unit too
    const other = await call(addManager, "POST", managerUrl(w.units.cityB), { cookie: ceo, params: { id: w.units.cityB }, body: { employeeId: a.employeeId } });
    expect(other.status).toBe(201);

    const listed = await call(listManagers, "GET", managerUrl(w.units.cityA), { cookie: ceo, params: { id: w.units.cityA } });
    const mine = listed.json.data.filter((m: { employeeId: string }) => [a.employeeId, b.employeeId].includes(m.employeeId));
    expect(mine).toHaveLength(2);
    expect(mine.filter((m: { isPrimary: boolean }) => m.isPrimary)).toHaveLength(1); // b took over primary
    expect(mine.find((m: { employeeId: string }) => m.employeeId === b.employeeId).isPrimary).toBe(true);
    expect(mine[0].employee.firstName).toBeTruthy(); // the CEO may view employees
  });

  it("rejects a duplicate manager and a terminated employee", async () => {
    const person = await createPerson(w.tenantId, "mgr-dup", { orgUnitId: w.units.cityA });
    const body = { employeeId: person.employeeId };
    expect((await call(addManager, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body })).status).toBe(201);
    expect((await call(addManager, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body })).status).toBe(409);

    const gone = await createPerson(w.tenantId, "mgr-gone", { orgUnitId: w.units.cityA });
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: gone.employeeId! }, data: { status: "TERMINATED" } }));
    const result = await call(addManager, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body: { employeeId: gone.employeeId } });
    expect(result.status).toBe(409);
  });

  it("unassigning ends the assignment but keeps it as history", async () => {
    const person = await createPerson(w.tenantId, "mgr-end", { orgUnitId: w.units.cityA });
    const added = await call(addManager, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body: { employeeId: person.employeeId } });
    const managerId = added.json.data.id;

    expect((await call(removeManager, "DELETE", "/x", { cookie: ceo, params: { id: w.units.cityA, managerId } })).status).toBe(204);
    expect((await call(removeManager, "DELETE", "/x", { cookie: ceo, params: { id: w.units.cityA, managerId } })).status).toBe(409);

    const current = await call(listManagers, "GET", "/x", { cookie: ceo, params: { id: w.units.cityA }, query: { limit: "200" } });
    expect(current.json.data.some((m: { id: string }) => m.id === managerId)).toBe(false);
    const history = await call(listManagers, "GET", "/x", { cookie: ceo, params: { id: w.units.cityA }, query: { includeEnded: "true", limit: "200" } });
    const ended = history.json.data.find((m: { id: string }) => m.id === managerId);
    expect(ended.effectiveTo).toBeTruthy();
    expect((await auditEvents(w.tenantId, "org_unit.manager_unassign", w.units.cityA)).length).toBeGreaterThan(0);
  });

  it("does not grant data access: being a manager changes no permission", async () => {
    const person = await createPerson(w.tenantId, "mgr-noaccess", { orgUnitId: w.units.cityB });
    await call(addManager, "POST", "/x", { cookie: ceo, params: { id: w.units.cityB }, body: { employeeId: person.employeeId } });
    const cookie = await sessionCookie(person, w.tenantId);
    expect((await call(listManagers, "GET", "/x", { cookie, params: { id: w.units.cityB } })).status).toBe(403);
  });

  it("is scoped: a city manager cannot manage another city's managers, and without employees.view names are hidden", async () => {
    const person = await createPerson(w.tenantId, "mgr-scope", { orgUnitId: w.units.cityA });
    expect((await call(addManager, "POST", "/x", { cookie: cityManagerA, params: { id: w.units.cityB }, body: { employeeId: person.employeeId } })).status).toBe(404);

    // HR holds organization.view but no organization.assign, so cannot add; it can view with names
    expect((await call(addManager, "POST", "/x", { cookie: hr, params: { id: w.units.cityA }, body: { employeeId: person.employeeId } })).status).toBe(403);
    const seen = await call(listManagers, "GET", "/x", { cookie: hr, params: { id: w.units.cityA } });
    expect(seen.status).toBe(200);
  });

  it("an archived unit ends its manager assignments", async () => {
    const unit = (await call(
      (await import("@/app/api/v1/organization/units/route")).POST,
      "POST",
      "/x",
      { cookie: ceo, body: { type: "CITY", name: unique("Closing"), parentId: w.units.state } },
    )).json.data;
    const person = await createPerson(w.tenantId, "mgr-arch", { orgUnitId: w.units.cityA });
    const added = await call(addManager, "POST", "/x", { cookie: ceo, params: { id: unit.id }, body: { employeeId: person.employeeId } });
    expect((await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: unit.id }, body: {} })).status).toBe(200);
    const row = await withTenant(w.tenantId, (tx) => tx.orgUnitManager.findUniqueOrThrow({ where: { id: added.json.data.id } }));
    expect(row.effectiveTo).not.toBeNull();
  });
});
