import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listAddresses, POST as addAddress } from "@/app/api/v1/customers/[id]/addresses/route";
import { PATCH as patchAddress } from "@/app/api/v1/customers/[id]/addresses/[addressId]/route";
import { POST as archiveAddress } from "@/app/api/v1/customers/[id]/addresses/[addressId]/archive/route";
import { GET as listNotes, POST as addNote } from "@/app/api/v1/customers/[id]/notes/route";
import { GET as getHistory } from "@/app/api/v1/customers/[id]/history/route";
import { GET as getPreferences, PUT as putPreferences } from "@/app/api/v1/customers/[id]/employee-preferences/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { assignJob, assignLead, makeCustomer, makeJob, makeLead } from "./fixtures";

let w: World;
let ceo: string;
let cityManagerA: string;
let cityManagerB: string;
let techA1: string;
let relations: string;
let dispatcher: string;

beforeAll(async () => {
  w = await buildWorld("customers-related");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  const relationsPerson = await createPerson(w.tenantId, "relations", { orgUnitId: w.units.cityA });
  await grantTemplate(w.tenantId, relationsPerson, w.roles.CUSTOMER_RELATIONS, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  relations = await sessionCookie(relationsPerson, w.tenantId);
});
afterAll(disconnect);

const address = (overrides: Record<string, unknown> = {}) => ({
  line1: `${Math.floor(Math.random() * 9000) + 100} Oak Ave`,
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  ...overrides,
});
const params = (id: string, extra: Record<string, string> = {}) => ({ id, ...extra });
const addAddr = (cookie: string, id: string, body: Record<string, unknown>) =>
  call(addAddress, "POST", "/x", { cookie, params: params(id), body });
const addrs = (cookie: string, id: string, query: Record<string, string> = {}) =>
  call(listAddresses, "GET", "/x", { cookie, params: params(id), query });

describe("addresses", () => {
  it("the first address is primary; the key is normalized; coordinates are optional and paired", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const first = await addAddr(cityManagerA, customer.id, address({ line1: "12 Main St.", postalCode: "62701-1234", latitude: 39.78, longitude: -89.65 }));
    expect(first.status).toBe(201);
    expect(first.json.data.address).toMatchObject({ isPrimary: true, latitude: 39.78, longitude: -89.65, coordinateSource: "manual" });
    const stored = await withTenant(w.tenantId, (tx) => tx.customerAddress.findUniqueOrThrow({ where: { id: first.json.data.address.id } }));
    expect(stored.normalizedKey).toBe("12 main st||springfield|il|62701|us");

    const second = await addAddr(cityManagerA, customer.id, address());
    expect(second.json.data.address.isPrimary).toBe(false);
    expect(second.json.data.address.latitude).toBeNull();

    expect((await addAddr(cityManagerA, customer.id, address({ latitude: 10 }))).status).toBe(400); // unpaired
    expect((await addAddr(cityManagerA, customer.id, address({ latitude: 91, longitude: 0 }))).status).toBe(400);
    expect((await addAddr(cityManagerA, customer.id, address({ countryCode: "USA" }))).status).toBe(400);
    expect((await addAddr(cityManagerA, customer.id, { line1: "x" })).status).toBe(400);
    expect((await addrs(cityManagerA, customer.id)).json.data).toHaveLength(2);
  });

  it("making another address primary moves the flag; archiving the primary promotes the oldest remaining", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const a = (await addAddr(ceo, customer.id, address())).json.data.address;
    const b = (await addAddr(ceo, customer.id, address())).json.data.address;
    const c = (await addAddr(ceo, customer.id, address())).json.data.address;

    const moved = await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: params(customer.id, { addressId: c.id }), body: { isPrimary: true } });
    expect(moved.status).toBe(200);
    expect((await addrs(ceo, customer.id)).json.data.map((row: { id: string }) => row.id)[0]).toBe(c.id);
    const stripped = await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: params(customer.id, { addressId: c.id }), body: { isPrimary: false } });
    expect(stripped.status).toBe(400);

    const archived = await call(archiveAddress, "POST", "/x", { cookie: ceo, params: params(customer.id, { addressId: c.id }) });
    expect(archived.status).toBe(200);
    const remaining = (await addrs(ceo, customer.id)).json.data;
    expect(remaining.map((row: { id: string }) => row.id)).toEqual([a.id, b.id]);
    expect(remaining[0].isPrimary).toBe(true);
    expect((await addrs(ceo, customer.id, { includeArchived: "true" })).json.data).toHaveLength(3);
    expect((await call(archiveAddress, "POST", "/x", { cookie: ceo, params: params(customer.id, { addressId: c.id }) })).status).toBe(409);
    expect((await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: params(customer.id, { addressId: c.id }), body: { city: "Elsewhere" } })).status).toBe(409);
  });

  it("an edit recomputes the matching key and audits the changed fields", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const created = (await addAddr(ceo, customer.id, address({ line1: "1 Elm St" }))).json.data.address;
    const edited = await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: params(customer.id, { addressId: created.id }), body: { line1: "2 Elm St", accessInstructions: "Gate code 1234" } });
    expect(edited.status).toBe(200);
    const stored = await withTenant(w.tenantId, (tx) => tx.customerAddress.findUniqueOrThrow({ where: { id: created.id } }));
    expect(stored.normalizedKey.startsWith("2 elm st|")).toBe(true);
    const [event] = await auditEvents(w.tenantId, "customer.address_update", created.id);
    expect(event.previousValue).toMatchObject({ line1: "1 Elm St" });
    expect(event.newValue).toMatchObject({ line1: "2 Elm St" });
  });

  it("follows the customer's scope: out of scope is 404, a technician may read but not write", async () => {
    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    expect((await addAddr(cityManagerA, inB.id, address())).status).toBe(404);
    expect((await addrs(cityManagerA, inB.id)).status).toBe(404);

    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    await assignJob(w.tenantId, await makeJob(w.tenantId, inA.id, w.units.cityA), { employeeId: w.techA1.employeeId! });
    expect((await addrs(techA1, inA.id)).status).toBe(200);
    expect((await addAddr(techA1, inA.id, address())).status).toBe(403);
  });

  it("an address's own service area needs authority over that unit", async () => {
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    expect((await addAddr(cityManagerA, inA.id, address({ orgUnitId: w.units.cityB }))).status).toBe(404);
    expect((await addAddr(cityManagerA, inA.id, address({ orgUnitId: w.units.teamA1 }))).status).toBe(201);
  });
});

describe("notes", () => {
  it("appends notes with author and time, newest first, and audits the note id only", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const first = await call(addNote, "POST", "/x", { cookie: cityManagerA, params: params(customer.id), body: { body: "Prefers morning visits" } });
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ authorId: w.cityManagerA.userId, body: "Prefers morning visits", customerId: customer.id });
    await call(addNote, "POST", "/x", { cookie: ceo, params: params(customer.id), body: { body: "Second note" } });

    const listed = await call(listNotes, "GET", "/x", { cookie: ceo, params: params(customer.id) });
    expect(listed.json.data.map((note: { body: string }) => note.body)).toEqual(["Second note", "Prefers morning visits"]);
    const [event] = await auditEvents(w.tenantId, "customer.note_add", first.json.data.id);
    expect(JSON.stringify(event.newValue)).not.toContain("morning");
  });

  it("rejects empty notes, and refuses out-of-scope customers (404) and read-only grants (403)", async () => {
    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    expect((await call(addNote, "POST", "/x", { cookie: cityManagerA, params: params(inB.id), body: { body: "x" } })).status).toBe(404);
    expect((await call(listNotes, "GET", "/x", { cookie: cityManagerA, params: params(inB.id) })).status).toBe(404);
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    expect((await call(addNote, "POST", "/x", { cookie: ceo, params: params(inA.id), body: { body: "" } })).status).toBe(400);
    await assignLead(w.tenantId, await makeLead(w.tenantId, inA.id), w.techA1.employeeId!);
    expect((await call(addNote, "POST", "/x", { cookie: techA1, params: params(inA.id), body: { body: "x" } })).status).toBe(403);
    expect((await call(listNotes, "GET", "/x", { cookie: techA1, params: params(inA.id) })).status).toBe(200);
  });
});

describe("employee preferences", () => {
  it("replaces the whole list, validates employees and audits the change", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const put = (cookie: string, preferences: unknown[]) =>
      call(putPreferences, "PUT", "/x", { cookie, params: params(customer.id), body: { preferences } });

    const first = await put(cityManagerA, [
      { employeeId: w.techA1.employeeId, kind: "PREFERRED", note: "Knows the building" },
      { employeeId: w.techA1Other.employeeId, kind: "AVOID" },
    ]);
    expect(first.status).toBe(200);
    expect(first.json.data).toHaveLength(2);

    const second = await put(cityManagerA, [{ employeeId: w.techA1.employeeId, kind: "AVOID" }]);
    expect(second.json.data).toEqual([expect.objectContaining({ employeeId: w.techA1.employeeId, kind: "AVOID" })]);
    expect((await call(getPreferences, "GET", "/x", { cookie: ceo, params: params(customer.id) })).json.data).toHaveLength(1);
    expect(await auditEvents(w.tenantId, "customer.preferences_set", customer.id)).toHaveLength(2);

    expect((await put(ceo, [{ employeeId: "nobody", kind: "PREFERRED" }])).status).toBe(400);
    expect((await put(ceo, [{ employeeId: w.techB.employeeId, kind: "PREFERRED" }, { employeeId: w.techB.employeeId, kind: "AVOID" }])).status).toBe(400);
    expect((await put(cityManagerB, [])).status).toBe(404);
  });
});

describe("history", () => {
  it("lists the customer's leads and jobs the caller may view, never beyond their own scope", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const leadInA = await makeLead(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const jobInA = await makeJob(w.tenantId, customer.id, w.units.cityA);
    const jobInB = await makeJob(w.tenantId, customer.id, w.units.cityB);
    await assignJob(w.tenantId, jobInA, { employeeId: w.techA1.employeeId! });
    const history = (cookie: string) => call(getHistory, "GET", "/x", { cookie, params: params(customer.id) });

    const asCeo = (await history(ceo)).json.data;
    expect(asCeo.leads.map((lead: { id: string }) => lead.id)).toEqual([leadInA]);
    expect(asCeo.jobs.map((job: { id: string }) => job.id).sort()).toEqual([jobInA, jobInB].sort());
    expect(asCeo.jobs[0]).toEqual(expect.objectContaining({ number: expect.any(Number), status: "CREATED" }));
    expect(asCeo.jobs[0]).not.toHaveProperty("quotedAmountMinor");
    expect(asCeo.access).toEqual({ leads: true, jobs: true });

    // City Manager A: both are theirs only inside City A.
    const asManager = (await history(cityManagerA)).json.data;
    expect(asManager.jobs.map((job: { id: string }) => job.id)).toEqual([jobInA]);
    // Customer Relations reaches jobs through the customer_history set, still inside its own unit.
    const asRelations = (await history(relations)).json.data;
    expect(asRelations.jobs.map((job: { id: string }) => job.id)).toEqual([jobInA]);
    expect(asRelations.leads.map((lead: { id: string }) => lead.id)).toEqual([leadInA]);
    // A technician sees only the job assigned to them (and has no customers.view over a customer without assignment: 404 above).
    const asTech = (await history(techA1)).json.data;
    expect(asTech.jobs.map((job: { id: string }) => job.id)).toEqual([jobInA]);
    expect(asTech.leads).toEqual([]);
    // A Dispatcher (job_related customers) sees the customer; its jobs are those in its unit scope.
    const asDispatcher = await history(dispatcher);
    expect(asDispatcher.status).toBe(200);
    expect(asDispatcher.json.data.jobs).toHaveLength(2);
    expect((await call(getHistory, "GET", "/x", { cookie: cityManagerB, params: params(customer.id) })).status).toBe(404);
  });

  it("respects the limit and validates it", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    for (let index = 0; index < 3; index += 1) await makeJob(w.tenantId, customer.id, w.units.cityA);
    const limited = await call(getHistory, "GET", "/x", { cookie: ceo, params: params(customer.id), query: { limit: "2" } });
    expect(limited.json.data.jobs).toHaveLength(2);
    expect((await call(getHistory, "GET", "/x", { cookie: ceo, params: params(customer.id), query: { limit: "0" } })).status).toBe(400);
  });
});
