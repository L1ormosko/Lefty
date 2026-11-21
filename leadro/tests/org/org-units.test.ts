import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listUnits, POST as createUnit } from "@/app/api/v1/organization/units/route";
import { GET as getUnit, PATCH as patchUnit } from "@/app/api/v1/organization/units/[id]/route";
import { POST as moveUnit } from "@/app/api/v1/organization/units/[id]/move/route";
import { POST as archiveUnit } from "@/app/api/v1/organization/units/[id]/archive/route";
import { moveOrgUnit } from "@/server/organization";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, type World } from "../authz/fixtures";
import { auditEvents, call, contextFor, sessionCookie } from "./org-helpers";

let w: World;
let ceo: string;
let cityManagerA: string;

beforeAll(async () => {
  w = await buildWorld("org-units");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
});
afterAll(disconnect);

const create = (cookie: string, body: unknown) => call(createUnit, "POST", "/api/v1/organization/units", { cookie, body });
const unitName = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

describe("org unit creation", () => {
  it("creates a unit under an allowed parent type, audits it with the request's correlation id", async () => {
    const result = await call(createUnit, "POST", "/api/v1/organization/units", {
      cookie: ceo,
      body: { type: "CITY", name: unitName("City"), parentId: w.units.state },
      headers: { "x-correlation-id": "corr-create-unit-0001" },
    });
    expect(result.status).toBe(201);
    expect(result.json.data).toMatchObject({ type: "CITY", parentId: w.units.state, active: true });

    const events = await auditEvents(w.tenantId, "org_unit.create", result.json.data.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: w.ceo.userId, correlationId: "corr-create-unit-0001", outcome: "SUCCESS" });
  });

  it("rejects a type that is not allowed under the parent's type", async () => {
    const result = await create(ceo, { type: "TEAM", name: unitName("Team"), parentId: w.units.state });
    expect(result.status).toBe(400);
    expect(result.json.error).toMatchObject({ code: "VALIDATION_FAILED", field: "parentId" });
  });

  it("rejects a top-level CITY (cities live under a state or region)", async () => {
    const result = await create(ceo, { type: "CITY", name: unitName("City") });
    expect(result.status).toBe(400);
  });

  it("rejects branch-only attributes on other unit types", async () => {
    const result = await create(ceo, { type: "CITY", name: unitName("City"), parentId: w.units.state, timeZone: "America/Chicago" });
    expect(result.status).toBe(400);
    expect(result.json.error.field).toBe("timeZone");
  });

  it("rejects a duplicate sibling name (case-insensitive)", async () => {
    const name = unitName("Dup");
    expect((await create(ceo, { type: "CITY", name, parentId: w.units.state })).status).toBe(201);
    const again = await create(ceo, { type: "CITY", name: name.toUpperCase(), parentId: w.units.state });
    expect(again.status).toBe(409);
  });

  it("lets a city manager create inside their own city, but not elsewhere or at the top (permission + scope)", async () => {
    const inside = await create(cityManagerA, { type: "TEAM", name: unitName("Team"), parentId: w.units.cityA });
    expect(inside.status).toBe(201);
    const otherCity = await create(cityManagerA, { type: "TEAM", name: unitName("Team"), parentId: w.units.cityB });
    expect(otherCity.status).toBe(404); // out of scope: existence not confirmed
    const top = await create(cityManagerA, { type: "STATE", name: unitName("State") });
    expect(top.status).toBe(403); // a top-level unit needs a tenant-wide grant
  });

  it("refuses a technician outright and records the denial", async () => {
    const technician = await sessionCookie(w.techA1, w.tenantId);
    const result = await create(technician, { type: "TEAM", name: unitName("Team"), parentId: w.units.cityA });
    expect(result.status).toBe(403);
    const denied = await auditEvents(w.tenantId, "authz.denied");
    expect(denied.some((event) => event.actorUserId === w.techA1.userId && event.correlationId === result.correlationId)).toBe(true);
  });

  it("requires authentication and validates the body", async () => {
    expect((await call(createUnit, "POST", "/api/v1/organization/units", { body: {} })).status).toBe(401);
    expect((await create(ceo, { type: "NOPE", name: "" })).status).toBe(400);
  });
});

describe("org unit move", () => {
  it("moves a unit under a new parent and audits previous and new parent", async () => {
    const city = (await create(ceo, { type: "CITY", name: unitName("Movable"), parentId: w.units.state })).json.data;
    const region = (await create(ceo, { type: "REGION", name: unitName("Region"), parentId: w.units.state })).json.data;
    const result = await call(moveUnit, "POST", `/api/v1/organization/units/${city.id}/move`, {
      cookie: ceo,
      params: { id: city.id },
      body: { newParentId: region.id, reason: "Reorg" },
    });
    expect(result.status).toBe(200);
    expect(result.json.data.parentId).toBe(region.id);
    const [event] = await auditEvents(w.tenantId, "org_unit.move", city.id);
    expect(event).toMatchObject({ previousValue: { parentId: w.units.state }, newValue: { parentId: region.id }, reason: "Reorg" });
  });

  it("rejects moving a unit under its own descendant (no cycle)", async () => {
    const result = await call(moveUnit, "POST", "/api/v1/organization/units/x/move", {
      cookie: ceo,
      params: { id: w.units.state },
      body: { newParentId: w.units.teamA1 }, // teamA1 sits below cityA below state
    });
    expect(result.status).toBe(400);
    expect(result.json.error.message).toMatch(/descendant/);
  });

  it("rejects moving a unit under itself", async () => {
    const result = await call(moveUnit, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body: { newParentId: w.units.cityA } });
    expect(result.status).toBe(400);
  });

  it("rejects a move under an archived unit", async () => {
    const archived = (await create(ceo, { type: "REGION", name: unitName("Gone"), parentId: w.units.state })).json.data;
    await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: archived.id }, body: {} });
    const city = (await create(ceo, { type: "CITY", name: unitName("City"), parentId: w.units.state })).json.data;
    const result = await call(moveUnit, "POST", "/x", { cookie: ceo, params: { id: city.id }, body: { newParentId: archived.id } });
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("needs authority over the destination too (a city manager cannot push a team into another city)", async () => {
    const team = (await create(cityManagerA, { type: "TEAM", name: unitName("Team"), parentId: w.units.cityA })).json.data;
    const result = await call(moveUnit, "POST", "/x", { cookie: cityManagerA, params: { id: team.id }, body: { newParentId: w.units.cityB } });
    expect(result.status).toBe(404);
  });

  it("serialises concurrent moves: the second sees the first's result (no lost update)", async () => {
    const parentA = (await create(ceo, { type: "REGION", name: unitName("RA"), parentId: w.units.state })).json.data;
    const parentB = (await create(ceo, { type: "REGION", name: unitName("RB"), parentId: w.units.state })).json.data;
    const city = (await create(ceo, { type: "CITY", name: unitName("Race"), parentId: w.units.state })).json.data;
    const ctx = contextFor(w.ceo.actor);

    const results = await Promise.allSettled([
      moveOrgUnit(w.ceo.actor, ctx, city.id, { newParentId: parentA.id }),
      moveOrgUnit(w.ceo.actor, ctx, city.id, { newParentId: parentB.id }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

    // Without the tenant tree lock both moves would read the original parent as "previous".
    const events = (await auditEvents(w.tenantId, "org_unit.move", city.id)).reverse();
    expect(events).toHaveLength(2);
    expect((events[0].previousValue as { parentId: string }).parentId).toBe(w.units.state);
    expect((events[1].previousValue as { parentId: string }).parentId).toBe((events[0].newValue as { parentId: string }).parentId);
  });
});

describe("org unit update and archive", () => {
  it("renames a unit and records only the changed fields", async () => {
    const city = (await create(ceo, { type: "CITY", name: unitName("Old"), parentId: w.units.state })).json.data;
    const result = await call(patchUnit, "PATCH", "/x", { cookie: ceo, params: { id: city.id }, body: { name: "Renamed Town" } });
    expect(result.status).toBe(200);
    expect(result.json.data.name).toBe("Renamed Town");
    const [event] = await auditEvents(w.tenantId, "org_unit.update", city.id);
    expect(event.previousValue).toEqual({ name: city.name });
    expect(event.newValue).toEqual({ name: "Renamed Town" });
  });

  it("refuses to archive a unit that still has active children or people", async () => {
    const withChildren = await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: w.units.cityA }, body: {} });
    expect(withChildren.status).toBe(409);
    const withPeople = await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: w.units.teamA1 }, body: {} });
    expect(withPeople.status).toBe(409);
    expect(withPeople.json.error.message).toMatch(/people/);
  });

  it("archives an empty unit (soft) and hides it from the default list", async () => {
    const city = (await create(ceo, { type: "CITY", name: unitName("Temp"), parentId: w.units.state })).json.data;
    const archived = await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: city.id }, body: { reason: "Closed" } });
    expect(archived.status).toBe(200);
    expect(archived.json.data.active).toBe(false);

    const listed = await call(listUnits, "GET", "/api/v1/organization/units", { cookie: ceo, query: { search: city.name } });
    expect(listed.json.data).toHaveLength(0);
    const all = await call(listUnits, "GET", "/api/v1/organization/units", { cookie: ceo, query: { search: city.name, active: "all" } });
    expect(all.json.data).toHaveLength(1);

    const again = await call(archiveUnit, "POST", "/x", { cookie: ceo, params: { id: city.id }, body: {} });
    expect(again.status).toBe(409);
  });
});

describe("org unit reads: scope, projection, pagination, isolation", () => {
  it("lists only the caller's scope: a city manager sees their city and what is below it", async () => {
    const result = await call(listUnits, "GET", "/api/v1/organization/units", { cookie: cityManagerA, query: { limit: "200" } });
    expect(result.status).toBe(200);
    const ids = result.json.data.map((unit: { id: string }) => unit.id);
    expect(ids).toContain(w.units.cityA);
    expect(ids).toContain(w.units.teamA1);
    expect(ids).not.toContain(w.units.cityB);
    expect(ids).not.toContain(w.units.state);
    expect(ids).not.toContain(w.units.outside);
  });

  it("paginates with an opaque cursor and never repeats or skips rows", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 50; pages += 1) {
      const result = await call(listUnits, "GET", "/api/v1/organization/units", {
        cookie: ceo,
        query: { limit: "3", ...(cursor ? { cursor } : {}) },
      });
      expect(result.status).toBe(200);
      expect(result.json.data.length).toBeLessThanOrEqual(3);
      seen.push(...result.json.data.map((unit: { id: string }) => unit.id));
      cursor = result.json.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([w.units.state, w.units.cityA, w.units.cityB, w.units.outside]));
  });

  it("rejects a bad limit and a garbage cursor", async () => {
    expect((await call(listUnits, "GET", "/x", { cookie: ceo, query: { limit: "5000" } })).status).toBe(400);
    const garbage = await call(listUnits, "GET", "/x", { cookie: ceo, query: { cursor: "AAAA" } }); // decodes to NUL bytes
    expect(garbage.status).toBe(400);
    expect(garbage.json.error.field).toBe("cursor");
    // A well-formed cursor that names no visible row (another tenant's, or invented) yields an empty page.
    const unknown = Buffer.from("cl0000000000000000000000").toString("base64url");
    const empty = await call(listUnits, "GET", "/x", { cookie: ceo, query: { cursor: unknown } });
    expect(empty.status).toBe(200);
    expect(empty.json.data).toEqual([]);
  });

  it("returns 404 for a unit outside the caller's scope and for another tenant's unit", async () => {
    expect((await call(getUnit, "GET", "/x", { cookie: cityManagerA, params: { id: w.units.cityB } })).status).toBe(404);

    const other = await buildWorld("org-units-other");
    expect((await call(getUnit, "GET", "/x", { cookie: ceo, params: { id: other.units.state } })).status).toBe(404);
    // ...and writes against it never touch the other tenant
    const patch = await call(patchUnit, "PATCH", "/x", { cookie: ceo, params: { id: other.units.state }, body: { name: "Hijacked" } });
    expect(patch.status).toBe(404);
    const row = await withTenant(other.tenantId, (tx) => tx.orgUnit.findUniqueOrThrow({ where: { id: other.units.state } }));
    expect(row.name).toBe("State S");
  });

  it("returns 401 for an expired or unknown session", async () => {
    expect((await call(listUnits, "GET", "/x", { cookie: "leadro_session=nope.nope" })).status).toBe(401);
  });

  it("is invisible to a person who is not active", async () => {
    const person = await createPerson(w.tenantId, "inactive", { orgUnitId: w.units.cityA });
    const cookie = await sessionCookie(person, w.tenantId);
    // No role at all: no permission.
    expect((await call(listUnits, "GET", "/x", { cookie })).status).toBe(403);
  });
});
