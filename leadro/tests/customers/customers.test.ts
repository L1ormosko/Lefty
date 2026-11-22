import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listCustomers, POST as createCustomer } from "@/app/api/v1/customers/route";
import { GET as getCustomer, PATCH as patchCustomer } from "@/app/api/v1/customers/[id]/route";
import { POST as archiveCustomer } from "@/app/api/v1/customers/[id]/archive/route";
import { POST as restoreCustomer } from "@/app/api/v1/customers/[id]/restore/route";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { makeCustomer } from "./fixtures";

let w: World;
let other: World;
let ceo: string;
let stateManager: string;
let cityManagerA: string;
let cityManagerB: string;
let finance: string;

beforeAll(async () => {
  w = await buildWorld("customers");
  other = await buildWorld("customers-other");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  stateManager = await sessionCookie(w.stateManager, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  finance = await sessionCookie(w.finance, w.tenantId);
});
afterAll(disconnect);

const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;
const create = (cookie: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(createCustomer, "POST", "/api/v1/customers", { cookie, body, headers });
const list = (cookie: string, query: Record<string, string> = {}) =>
  call(listCustomers, "GET", "/api/v1/customers", { cookie, query });
const get = (cookie: string, id: string) => call(getCustomer, "GET", `/api/v1/customers/${id}`, { cookie, params: { id } });
const patch = (cookie: string, id: string, body: Record<string, unknown>) =>
  call(patchCustomer, "PATCH", `/api/v1/customers/${id}`, { cookie, params: { id }, body });
const names = (result: { json: { data: Array<{ name?: string }> } }) => result.json.data.map((row) => row.name);

describe("customer creation", () => {
  it("creates a customer in the creator's unit, numbers it, normalizes phone/email and audits it", async () => {
    const result = await create(cityManagerA, {
      name: unique("Alice "),
      email: "Alice@Example.Test",
      phone: "(555) 123-4567",
      preferredLocale: "es-US",
      orgUnitId: w.units.cityA,
      addresses: [{ line1: "12 Main St.", city: "Springfield", region: "IL", postalCode: "62701" }],
    });
    expect(result.status).toBe(201);
    const customer = result.json.data;
    expect(customer).toMatchObject({
      email: "alice@example.test",
      phone: "(555) 123-4567",
      phoneE164: "+15551234567",
      preferredLocale: "es-US",
      kind: "INDIVIDUAL",
      doNotContact: false,
      orgUnitId: w.units.cityA,
      possibleDuplicates: [],
    });
    expect(customer.number).toBeGreaterThan(0);
    expect(customer.addresses).toHaveLength(1);
    expect(customer.addresses[0]).toMatchObject({ isPrimary: true, countryCode: "US", latitude: null });
    const [event] = await auditEvents(w.tenantId, "customer.create", customer.id);
    expect(event.actorUserId).toBe(w.cityManagerA.userId);
  });

  it("hands out consecutive numbers per tenant", async () => {
    const first = (await create(ceo, { name: unique("Num "), orgUnitId: w.units.cityA })).json.data.number;
    const second = (await create(ceo, { name: unique("Num "), orgUnitId: w.units.cityA })).json.data.number;
    expect(second).toBe(first + 1);
  });

  it("refuses a unit outside the creator's scope (404) and a unit-less customer without a tenant-wide grant (403)", async () => {
    expect((await create(cityManagerA, { name: unique("X "), orgUnitId: w.units.cityB })).status).toBe(404);
    expect((await create(cityManagerA, { name: unique("X ") })).status).toBe(403);
    expect((await create(ceo, { name: unique("Tenant-level ") })).status).toBe(201);
  });

  it("rejects an archived unit and invalid input", async () => {
    const archived = await withTenant(w.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "CITY", name: unique("Closed"), parentId: w.units.state, active: false } }),
    );
    expect((await create(ceo, { name: unique("X "), orgUnitId: archived.id })).status).toBe(409);
    expect((await create(ceo, { name: "" })).status).toBe(400);
    expect((await create(ceo, { name: "X", phone: "12" })).status).toBe(400);
    expect((await create(ceo, { name: "X", phone: "0123456" })).status).toBe(400); // not normalizable without a country
    expect((await create(ceo, { name: "X", email: "not-an-email" })).status).toBe(400);
    expect((await create(ceo, { name: "X", preferredLocale: "fr-FR" })).status).toBe(400);
    expect((await create(ceo, { name: "X", tenantId: other.tenantId })).status).toBe(400); // unknown field: the tenant never comes from the body
  });

  it("only a grant that names the billing set may write billing fields", async () => {
    const denied = await create(cityManagerA, { name: unique("B "), orgUnitId: w.units.cityA, taxId: "12-3456789" });
    expect(denied.status).toBe(403);
    const allowed = await create(ceo, { name: unique("B "), orgUnitId: w.units.cityA, taxId: "12-3456789", paymentTerms: "NET30" });
    expect(allowed.status).toBe(201);
    expect(allowed.json.data).toMatchObject({ taxId: "12-3456789", paymentTerms: "NET30" });
  });

  it("replays an idempotent retry instead of creating a second customer", async () => {
    const body = { name: unique("Idem "), orgUnitId: w.units.cityA };
    const headers = { "idempotency-key": unique("key-") };
    const first = await create(ceo, body, headers);
    const second = await create(ceo, body, headers);
    expect(second.status).toBe(201);
    expect(second.json.data.id).toBe(first.json.data.id);
  });
});

describe("reading customers: scope and field projection", () => {
  let inA: { id: string; name: string };
  let inB: { id: string; name: string };
  let unplaced: { id: string; name: string };

  beforeAll(async () => {
    inA = await makeCustomer(w.tenantId, { name: unique("ScopeA "), orgUnitId: w.units.cityA, taxId: "AAA-1" });
    inB = await makeCustomer(w.tenantId, { name: unique("ScopeB "), orgUnitId: w.units.cityB, taxId: "BBB-1" });
    unplaced = await makeCustomer(w.tenantId, { name: unique("ScopeNone ") });
  });

  it("lists only the customers inside the caller's units (descendants included), never fetch-then-filter", async () => {
    const asCityA = names(await list(cityManagerA, { q: "Scope" }));
    expect(asCityA).toEqual([inA.name]);
    const asState = names(await list(stateManager, { q: "Scope" }));
    expect(asState).toEqual([inA.name, inB.name].sort());
    const asCeo = names(await list(ceo, { q: "Scope" }));
    expect(asCeo).toEqual([inA.name, inB.name, unplaced.name].sort());
  });

  it("a customer outside the caller's scope is a 404, the same as a missing one", async () => {
    expect((await get(cityManagerA, inB.id)).status).toBe(404);
    expect((await get(cityManagerA, "does-not-exist")).status).toBe(404);
    expect((await get(cityManagerA, unplaced.id)).status).toBe(404); // unplaced = tenant-level
    expect((await get(cityManagerA, inA.id)).status).toBe(200);
    expect((await get(ceo, unplaced.id)).status).toBe(200);
  });

  it("hides billing columns from plain grants and reveals them to the billing grants, per row", async () => {
    const plain = (await get(cityManagerA, inA.id)).json.data;
    expect(plain.name).toBe(inA.name);
    expect(plain).not.toHaveProperty("taxId");
    expect(plain).not.toHaveProperty("paymentTerms");
    expect((await get(ceo, inA.id)).json.data.taxId).toBe("AAA-1");

    const asCeoList = (await list(ceo, { q: "ScopeA" })).json.data[0];
    expect(asCeoList.taxId).toBe("AAA-1");
    const asManagerList = (await list(cityManagerA, { q: "ScopeA" })).json.data[0];
    expect(asManagerList).not.toHaveProperty("taxId");
  });

  it("a billing-only grant (Finance) sees the billing set and none of the base fields", async () => {
    const row = (await get(finance, inA.id)).json.data;
    expect(row.taxId).toBe("AAA-1");
    expect(row).not.toHaveProperty("name");
    expect(row).not.toHaveProperty("phone");
    const rows = (await list(finance, { q: "ScopeA" })).json.data;
    expect(rows).toHaveLength(0); // search matches on columns the grant hides; it must not be an oracle
  });

  it("never returns another tenant's customers", async () => {
    const foreign = await makeCustomer(other.tenantId, { name: unique("Foreign ") });
    expect((await get(ceo, foreign.id)).status).toBe(404);
    expect(names(await list(ceo, { q: "Foreign" }))).toEqual([]);
    const forgedUnit = await create(ceo, { name: unique("Forge "), orgUnitId: other.units.cityA });
    expect(forgedUnit.status).toBe(404);
  });
});

describe("search, filters and pagination", () => {
  beforeAll(async () => {
    await makeCustomer(w.tenantId, { name: "Searchable Smith Plumbing", orgUnitId: w.units.cityA, phoneE164: "+15559876543", email: "smith@search.test" });
    await makeCustomer(w.tenantId, { name: "Searchable Jones", orgUnitId: w.units.cityA, archived: true });
  });

  it("finds customers by name, email, partial phone digits and number", async () => {
    expect(names(await list(ceo, { q: "smith plumb" }))).toEqual(["Searchable Smith Plumbing"]);
    expect(names(await list(ceo, { q: "smith@search" }))).toEqual(["Searchable Smith Plumbing"]);
    expect(names(await list(ceo, { q: "(555) 987-65" }))).toEqual(["Searchable Smith Plumbing"]);
    const found = (await list(ceo, { q: "smith plumb" })).json.data[0];
    expect(names(await list(ceo, { q: `#${found.number}` }))).toContain("Searchable Smith Plumbing");
  });

  it("hides archived customers unless asked", async () => {
    expect(names(await list(ceo, { q: "Searchable Jones" }))).toEqual([]);
    expect(names(await list(ceo, { q: "Searchable Jones", archived: "only" }))).toEqual(["Searchable Jones"]);
    expect(names(await list(ceo, { q: "Searchable", archived: "include" }))).toHaveLength(2);
  });

  it("pages through every customer exactly once with the opaque cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { limit: "2", q: "Scope" };
      if (cursor) query.cursor = cursor;
      const page = await list(ceo, query);
      expect(page.status).toBe(200);
      seen.push(...page.json.data.map((row: { id: string }) => row.id));
      cursor = page.json.page.nextCursor;
    } while (cursor);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects bad query parameters", async () => {
    expect((await list(ceo, { limit: "0" })).status).toBe(400);
    expect((await list(ceo, { archived: "maybe" })).status).toBe(400);
  });
});

describe("updating, archiving and restoring", () => {
  it("updates changed fields only, audits previous and new values, and keeps billing values out of the audit log", async () => {
    const created = (await create(ceo, { name: unique("Upd "), orgUnitId: w.units.cityA, phone: "555 000 1111", taxId: "OLD-TAX" })).json.data;
    const result = await patch(ceo, created.id, { name: "Renamed Customer", phone: "(555) 000-2222", taxId: "NEW-TAX", doNotContact: true });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ name: "Renamed Customer", phoneE164: "+15550002222", taxId: "NEW-TAX", doNotContact: true });

    const [event] = await auditEvents(w.tenantId, "customer.update", created.id);
    expect(event.previousValue).toMatchObject({ name: created.name, phoneE164: "+15550001111" });
    expect(event.newValue).toMatchObject({ name: "Renamed Customer", phoneE164: "+15550002222", billingFieldsChanged: ["taxId"] });
    expect(JSON.stringify(event.newValue)).not.toContain("NEW-TAX");
    expect(JSON.stringify(event.previousValue)).not.toContain("OLD-TAX");
  });

  it("a no-op patch writes no audit event", async () => {
    const created = (await create(ceo, { name: unique("Noop "), orgUnitId: w.units.cityA })).json.data;
    expect((await patch(ceo, created.id, { name: created.name })).status).toBe(200);
    expect(await auditEvents(w.tenantId, "customer.update", created.id)).toHaveLength(0);
  });

  it("refuses edits outside scope (404), billing fields without the billing grant (403) and empty or unknown fields (400)", async () => {
    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    expect((await patch(cityManagerA, inB.id, { name: "Hijack" })).status).toBe(404);
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    expect((await patch(cityManagerA, inA.id, { taxId: "X" })).status).toBe(403);
    expect((await patch(cityManagerA, inA.id, {})).status).toBe(400);
    expect((await patch(cityManagerA, inA.id, { number: 5 })).status).toBe(400);
    expect((await patch(finance, inA.id, { name: "Nope" })).status).toBe(403);
  });

  it("moving the service area needs authority over the destination", async () => {
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    expect((await patch(cityManagerA, inA.id, { orgUnitId: w.units.cityB })).status).toBe(404);
    expect((await patch(cityManagerA, inA.id, { orgUnitId: null })).status).toBe(403);
    expect((await patch(stateManager, inA.id, { orgUnitId: w.units.cityB })).status).toBe(200);
    expect((await get(cityManagerA, inA.id)).status).toBe(404); // it left City A's scope
    expect((await patch(ceo, inA.id, { orgUnitId: null })).status).toBe(200);
  });

  it("archives (soft) and restores, with audit, and archived customers are read-only", async () => {
    const created = (await create(ceo, { name: unique("Arch "), orgUnitId: w.units.cityA })).json.data;
    const archived = await call(archiveCustomer, "POST", "/x", { cookie: ceo, params: { id: created.id }, body: { reason: "Moved away" } });
    expect(archived.status).toBe(200);
    expect(archived.json.data.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [event] = await auditEvents(w.tenantId, "customer.archive", created.id);
    expect(event.reason).toBe("Moved away");

    expect((await call(archiveCustomer, "POST", "/x", { cookie: ceo, params: { id: created.id } })).status).toBe(409);
    expect((await patch(ceo, created.id, { name: "Changed" })).status).toBe(409);
    expect((await get(ceo, created.id)).json.data.archivedAt).not.toBeNull(); // still readable: nothing is deleted

    expect((await call(restoreCustomer, "POST", "/x", { cookie: ceo, params: { id: created.id } })).status).toBe(200);
    expect((await get(ceo, created.id)).json.data.archivedAt).toBeNull();
    expect((await call(restoreCustomer, "POST", "/x", { cookie: ceo, params: { id: created.id } })).status).toBe(409);
  });

  it("archiving needs the archive permission over the customer (City managers hold none)", async () => {
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    expect((await call(archiveCustomer, "POST", "/x", { cookie: cityManagerA, params: { id: inA.id } })).status).toBe(403);
    expect((await call(archiveCustomer, "POST", "/x", { cookie: cityManagerB, params: { id: inA.id } })).status).toBe(403);
  });

  it("requires authentication", async () => {
    expect((await call(listCustomers, "GET", "/api/v1/customers", {})).status).toBe(401);
  });
});
