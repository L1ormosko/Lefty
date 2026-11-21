import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as history, POST as assign } from "@/app/api/v1/employees/[id]/assignments/route";
import { POST as endAssignment } from "@/app/api/v1/employees/[id]/assignments/[assignmentId]/end/route";
import { GET as orgUnitAtRoute } from "@/app/api/v1/employees/[id]/org-unit-at/route";
import { PATCH as patchEmployee } from "@/app/api/v1/employees/[id]/route";
import { orgUnitAt } from "@/server/employees";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let ceo: string;
let cityManagerA: string;
let hr: string;

beforeAll(async () => {
  w = await buildWorld("assignments");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  hr = await sessionCookie(w.hr, w.tenantId);
});
afterAll(disconnect);

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const place = (cookie: string, employeeId: string, body: Record<string, unknown>) =>
  call(assign, "POST", `/api/v1/employees/${employeeId}/assignments`, { cookie, params: { id: employeeId }, body });
const rows = (employeeId: string) =>
  withTenant(w.tenantId, (tx) => tx.organizationalAssignment.findMany({ where: { employeeId }, orderBy: { effectiveFrom: "asc" } }));

describe("transfers keep history", () => {
  it("closes the current PRIMARY row and inserts a new one; nothing is overwritten", async () => {
    const worker = await createPerson(w.tenantId, "mover", { orgUnitId: w.units.cityA });
    const before = (await rows(worker.employeeId!))[0];

    const result = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, reason: "Relocation" });
    expect(result.status).toBe(201);
    expect(result.json.data).toMatchObject({ orgUnitId: w.units.cityB, kind: "PRIMARY", previousOrgUnitId: w.units.cityA, reason: "Relocation", createdById: w.ceo.userId });

    const after = await rows(worker.employeeId!);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: before.id, orgUnitId: w.units.cityA }); // same row, same unit
    expect(after[0].effectiveFrom.getTime()).toBe(before.effectiveFrom.getTime()); // start untouched
    expect(after[0].effectiveTo?.getTime()).toBe(after[1].effectiveFrom.getTime()); // closed exactly where the new one starts
    expect(after[1].effectiveTo).toBeNull();

    const [event] = await auditEvents(w.tenantId, "employee.assign", worker.employeeId!);
    expect(event).toMatchObject({ previousValue: { orgUnitId: w.units.cityA }, reason: "Relocation" });
  });

  it("answers 'where was this person on that date' from history (orgUnitAt)", async () => {
    const worker = await createPerson(w.tenantId, "historian", { orgUnitId: w.units.cityA }); // placed yesterday
    const moveAt = iso(1);
    expect((await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, effectiveFrom: moveAt })).status).toBe(201);

    const at = (offsetDays: number) => orgUnitAt(w.tenantId, worker.employeeId!, new Date(Date.now() + offsetDays * DAY));
    expect((await at(-10))?.orgUnitId).toBeUndefined(); // before they were placed anywhere
    expect((await at(0))?.orgUnitId).toBe(w.units.cityA); // scheduled move has not happened yet
    expect((await at(2))?.orgUnitId).toBe(w.units.cityB);

    const viaApi = await call(orgUnitAtRoute, "GET", "/x", { cookie: ceo, params: { id: worker.employeeId! }, query: { date: iso(2) } });
    expect(viaApi.json.data.orgUnitId).toBe(w.units.cityB);
    const none = await call(orgUnitAtRoute, "GET", "/x", { cookie: ceo, params: { id: worker.employeeId! }, query: { date: iso(-30) } });
    expect(none.json.data).toBeNull();
  });

  it("serves a placement history with previous unit, dates, who and why", async () => {
    const worker = await createPerson(w.tenantId, "timeline", { orgUnitId: w.units.cityA });
    await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, reason: "First move" });
    await place(ceo, worker.employeeId!, { orgUnitId: w.units.teamA1, reason: "Second move", effectiveFrom: iso(1) });

    const result = await call(history, "GET", "/x", { cookie: ceo, params: { id: worker.employeeId! } });
    expect(result.status).toBe(200);
    const [latest, middle, first] = result.json.data;
    expect(latest).toMatchObject({ orgUnitId: w.units.teamA1, previousOrgUnitId: w.units.cityB, reason: "Second move", createdById: w.ceo.userId });
    expect(middle).toMatchObject({ orgUnitId: w.units.cityB, previousOrgUnitId: w.units.cityA });
    expect(first).toMatchObject({ orgUnitId: w.units.cityA, previousOrgUnitId: null });
    expect(first.effectiveTo).toBeTruthy();

    const paged = await call(history, "GET", "/x", { cookie: ceo, params: { id: worker.employeeId! }, query: { limit: "1" } });
    expect(paged.json.data).toHaveLength(1);
    expect(paged.json.page.nextCursor).toBeTruthy();
  });

  it("refuses to rewrite history: backdating before the current placement, same unit, overlapping end", async () => {
    const worker = await createPerson(w.tenantId, "strict", { orgUnitId: w.units.cityA });
    const backdated = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, effectiveFrom: iso(-30) });
    expect(backdated.status).toBe(400);
    expect(backdated.json.error.field).toBe("effectiveFrom");
    const same = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityA });
    expect(same.status).toBe(400);
    expect(await rows(worker.employeeId!)).toHaveLength(1);
  });

  it("a PRIMARY placement takes no end date", async () => {
    const worker = await createPerson(w.tenantId, "noend", { orgUnitId: w.units.cityA });
    expect((await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, effectiveTo: iso(5) })).status).toBe(400);
  });

  it("serialises concurrent transfers: exactly one open PRIMARY remains", async () => {
    const worker = await createPerson(w.tenantId, "racer", { orgUnitId: w.units.cityA });
    const results = await Promise.all([
      place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB }),
      place(ceo, worker.employeeId!, { orgUnitId: w.units.teamA1 }),
    ]);
    // The per-employee lock makes them run one after the other: the second sees the first's row and
    // closes it (or, if both got the same millisecond, is refused as a history rewrite). Never a 500.
    const statuses = results.map((r) => r.status);
    expect(statuses.every((status) => status === 201 || status === 400)).toBe(true);
    expect(statuses).toContain(201);
    const all = await rows(worker.employeeId!);
    expect(all.filter((row) => row.effectiveTo === null)).toHaveLength(1); // exactly one open PRIMARY
    for (let index = 1; index < all.length; index += 1) {
      expect(all[index - 1].effectiveTo?.getTime()).toBe(all[index].effectiveFrom.getTime()); // gapless, no overlap
    }
  });
});

describe("temporary and secondary placements; legal employer is separate", () => {
  it("adds a temporary placement beside the primary one (a person in two units), then ends it", async () => {
    const worker = await createPerson(w.tenantId, "temp", { orgUnitId: w.units.cityA });
    const missingEnd = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, kind: "TEMPORARY" });
    expect(missingEnd.status).toBe(400);

    const temp = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, kind: "TEMPORARY", effectiveTo: iso(14), reason: "Cover" });
    expect(temp.status).toBe(201);
    const open = (await rows(worker.employeeId!)).filter((row) => row.effectiveTo === null || row.effectiveTo > new Date());
    expect(open.map((row) => row.orgUnitId).sort()).toEqual([w.units.cityA, w.units.cityB].sort());

    // the primary placement (operational team) is still the one reporting uses
    expect((await orgUnitAt(w.tenantId, worker.employeeId!, new Date()))?.orgUnitId).toBe(w.units.cityA);

    const duplicate = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, kind: "SECONDARY" });
    expect(duplicate.status).toBe(409);

    const ended = await call(endAssignment, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId!, assignmentId: temp.json.data.id }, body: {} });
    expect(ended.status).toBe(200);
    expect(ended.json.data.effectiveTo).toBeTruthy();
    expect((await call(endAssignment, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId!, assignmentId: temp.json.data.id }, body: {} })).status).toBe(409);
  });

  it("cannot end a PRIMARY placement or extend a temporary one", async () => {
    const worker = await createPerson(w.tenantId, "primary-end", { orgUnitId: w.units.cityA });
    const [primary] = await rows(worker.employeeId!);
    expect((await call(endAssignment, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId!, assignmentId: primary.id }, body: {} })).status).toBe(409);

    const temp = await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB, kind: "TEMPORARY", effectiveTo: iso(3) });
    const longer = await call(endAssignment, "POST", "/x", { cookie: ceo, params: { id: worker.employeeId!, assignmentId: temp.json.data.id }, body: { effectiveTo: iso(30) } });
    expect(longer.status).toBe(400);
  });

  it("legal employer and operational placement change independently", async () => {
    const second = await withTenant(w.tenantId, (tx) => tx.legalEntity.create({ data: { tenantId: w.tenantId, name: `Second LE ${Date.now()}` } }));
    const worker = await createPerson(w.tenantId, "employer", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });

    const changed = await call(patchEmployee, "PATCH", "/x", { cookie: ceo, params: { id: worker.employeeId! }, body: { legalEntityId: second.id } });
    expect(changed.json.data.legalEntityId).toBe(second.id);
    expect(changed.json.data.currentOrgUnitIds).toEqual([w.units.cityA]); // placement untouched
    expect(await rows(worker.employeeId!)).toHaveLength(1);
  });
});

describe("authority for placements", () => {
  it("needs employees.assign over the employee AND over the destination unit", async () => {
    const worker = await createPerson(w.tenantId, "scoped", { orgUnitId: w.units.cityA });
    // City manager A controls the employee but not City B
    expect((await place(cityManagerA, worker.employeeId!, { orgUnitId: w.units.cityB })).status).toBe(404);
    // ...and may move people inside their own subtree
    expect((await place(cityManagerA, worker.employeeId!, { orgUnitId: w.units.teamA1 })).status).toBe(201);
    // ...but cannot pull someone out of a unit they do not control
    const foreign = await createPerson(w.tenantId, "foreign", { orgUnitId: w.units.cityB });
    expect((await place(cityManagerA, foreign.employeeId!, { orgUnitId: w.units.cityA })).status).toBe(404);
    // HR holds employees.assign tenant-wide
    expect((await place(hr, foreign.employeeId!, { orgUnitId: w.units.cityA })).status).toBe(201);
  });

  it("rejects archived destinations, terminated employees and unknown ids; other tenants' units look missing", async () => {
    const worker = await createPerson(w.tenantId, "guarded", { orgUnitId: w.units.cityA });
    const archived = await withTenant(w.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "CITY", name: `Closed ${Date.now()}`, parentId: w.units.state, active: false } }),
    );
    expect((await place(ceo, worker.employeeId!, { orgUnitId: archived.id })).status).toBe(409);
    expect((await place(ceo, worker.employeeId!, { orgUnitId: "nope" })).status).toBe(404);

    const other = await buildWorld("assignments-other");
    expect((await place(ceo, worker.employeeId!, { orgUnitId: other.units.cityA })).status).toBe(404);
    expect((await place(ceo, other.techA1.employeeId!, { orgUnitId: w.units.cityA })).status).toBe(404);

    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: worker.employeeId! }, data: { status: "TERMINATED" } }));
    expect((await place(ceo, worker.employeeId!, { orgUnitId: w.units.cityB })).status).toBe(409); // terminated people cannot be placed
  });

  it("an archive racing a placement never leaves someone in an archived unit", async () => {
    const { archiveOrgUnit, createOrgUnit } = await import("@/server/organization");
    const { contextFor } = await import("../org/org-helpers");
    const ctx = contextFor(w.ceo.actor);
    const unit = await createOrgUnit(w.ceo.actor, ctx, { type: "CITY", name: `Race ${Date.now()}`, parentId: w.units.state });
    const worker = await createPerson(w.tenantId, "racing", { orgUnitId: w.units.cityA });

    const [archived, placed] = await Promise.allSettled([
      archiveOrgUnit(w.ceo.actor, ctx, unit.id!, {}),
      place(ceo, worker.employeeId!, { orgUnitId: unit.id! }),
    ]);
    const placement = placed.status === "fulfilled" && placed.value.status === 201;
    const unitNowArchived = archived.status === "fulfilled";
    expect(placement && unitNowArchived).toBe(false); // exactly one of them lost
    const people = await withTenant(w.tenantId, (tx) => tx.organizationalAssignment.count({ where: { orgUnitId: unit.id!, effectiveTo: null } }));
    const row = await withTenant(w.tenantId, (tx) => tx.orgUnit.findUniqueOrThrow({ where: { id: unit.id! } }));
    expect(row.active === false && people > 0).toBe(false);
  });
});
