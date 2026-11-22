import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getMatchers, PUT as putMatchers } from "@/app/api/v1/customers/duplicate-matchers/route";
import { GET as listFlags } from "@/app/api/v1/customers/duplicates/route";
import { POST as resolveFlag } from "@/app/api/v1/customers/duplicates/[flagId]/resolve/route";
import { POST as createCustomer } from "@/app/api/v1/customers/route";
import { PATCH as patchCustomer } from "@/app/api/v1/customers/[id]/route";
import { POST as addAddress } from "@/app/api/v1/customers/[id]/addresses/route";
import { findDuplicateCustomerCandidates, DEFAULT_DUPLICATE_MATCHERS } from "@/server/customers";
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

beforeAll(async () => {
  w = await buildWorld("customers-dup");
  other = await buildWorld("customers-dup-other");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  stateManager = await sessionCookie(w.stateManager, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
});
afterAll(disconnect);

let sequence = 0;
/** A phone number unique to one test, so tests never match each other's customers. */
const phone = () => `(555) ${String(200 + (sequence += 1)).padStart(3, "0")}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;
const create = (cookie: string, body: Record<string, unknown>) => call(createCustomer, "POST", "/x", { cookie, body });
const flagsFor = (tenantId: string, customerId: string) =>
  withTenant(tenantId, (tx) => tx.duplicateFlag.findMany({ where: { OR: [{ customerId }, { otherCustomerId: customerId }] } }));
const queue = (cookie: string, query: Record<string, string> = {}) => call(listFlags, "GET", "/x", { cookie, query });

const setMatchers = (matchers: Record<string, boolean>) => call(putMatchers, "PUT", "/x", { cookie: ceo, body: matchers });
const resetMatchers = () => setMatchers({ phone: true, email: true, address: true, name: false });

describe("detection on create", () => {
  it("flags a customer with the same phone (any formatting) and tells the creator, without blocking or merging", async () => {
    const number = phone();
    const first = (await create(ceo, { name: unique("Original "), phone: number, orgUnitId: w.units.cityA })).json.data;
    const second = await create(ceo, { name: unique("Same phone "), phone: number.replace(/[() -]/g, ""), orgUnitId: w.units.cityA });
    expect(second.status).toBe(201);
    expect(second.json.data.possibleDuplicates).toEqual([expect.objectContaining({ customerId: first.id, matchedOn: ["PHONE"] })]);

    const flags = await flagsFor(w.tenantId, first.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "CUSTOMER_CUSTOMER", status: "OPEN", matchedOn: ["PHONE"] });
    expect([flags[0].customerId, flags[0].otherCustomerId].sort()).toEqual([first.id, second.json.data.id].sort());
    expect(flags[0].customerId < flags[0].otherCustomerId!).toBe(true);
    // Both records still exist: nothing was merged.
    const count = await withTenant(w.tenantId, (tx) => tx.customer.count({ where: { id: { in: [first.id, second.json.data.id] } } }));
    expect(count).toBe(2);
    expect(await auditEvents(w.tenantId, "customer.duplicate_flag", flags[0].id)).toHaveLength(1);
  });

  it("matches on email and on a normalized address, and reports every matcher that hit", async () => {
    const email = `${unique("dup")}@match.test`;
    const first = (
      await create(ceo, { name: unique("A "), email, orgUnitId: w.units.cityA, addresses: [{ line1: "77 Birch Rd.", city: "Dayton", region: "OH", postalCode: "45402" }] })
    ).json.data;
    const second = await create(ceo, {
      name: unique("B "),
      email: email.toUpperCase(),
      orgUnitId: w.units.cityA,
      addresses: [{ line1: "77  birch rd", city: "DAYTON", region: "oh", postalCode: "45402-1111" }],
    });
    expect(second.json.data.possibleDuplicates).toEqual([expect.objectContaining({ customerId: first.id, matchedOn: ["EMAIL", "ADDRESS"] })]);
  });

  it("detects through an address added later", async () => {
    const first = (await create(ceo, { name: unique("C "), orgUnitId: w.units.cityA, addresses: [{ line1: "5 Pine Ct", city: "Tulsa", region: "OK", postalCode: "74101" }] })).json.data;
    const second = (await create(ceo, { name: unique("D "), orgUnitId: w.units.cityA })).json.data;
    const added = await call(addAddress, "POST", "/x", { cookie: ceo, params: { id: second.id }, body: { line1: "5 Pine Ct.", city: "Tulsa", region: "OK", postalCode: "74101" } });
    expect(added.status).toBe(201);
    expect(added.json.data.possibleDuplicates).toEqual([expect.objectContaining({ customerId: first.id, matchedOn: ["ADDRESS"] })]);
  });

  it("detects through an update of the phone, and does not duplicate an existing flag", async () => {
    const number = phone();
    const first = (await create(ceo, { name: unique("E "), phone: number, orgUnitId: w.units.cityA })).json.data;
    const second = (await create(ceo, { name: unique("F "), orgUnitId: w.units.cityA })).json.data;
    const edited = await call(patchCustomer, "PATCH", "/x", { cookie: ceo, params: { id: second.id }, body: { phone: number } });
    expect(edited.json.data.possibleDuplicates).toEqual([expect.objectContaining({ customerId: first.id })]);
    await call(patchCustomer, "PATCH", "/x", { cookie: ceo, params: { id: second.id }, body: { name: unique("F2 ") } });
    expect(await flagsFor(w.tenantId, first.id)).toHaveLength(1);
  });

  it("never looks at another tenant's customers", async () => {
    const number = phone();
    await makeCustomer(other.tenantId, { phoneE164: `+1${number.replace(/\D/g, "")}` });
    const mine = await create(ceo, { name: unique("G "), phone: number, orgUnitId: w.units.cityA });
    expect(mine.json.data.possibleDuplicates).toEqual([]);
  });
});

describe("configurable matchers", () => {
  it("honours the tenant configuration: a disabled matcher does not flag, the name matcher can be turned on", async () => {
    try {
      const number = phone();
      const name = unique("Same Name ");
      await create(ceo, { name, phone: number, orgUnitId: w.units.cityA });

      expect((await setMatchers({ phone: false, email: true, address: true, name: false })).status).toBe(200);
      const noPhone = await create(ceo, { name: unique("Other "), phone: number, orgUnitId: w.units.cityA });
      expect(noPhone.json.data.possibleDuplicates).toEqual([]);

      expect((await setMatchers({ phone: false, email: false, address: false, name: true })).status).toBe(200);
      const byName = await create(ceo, { name: name.toUpperCase(), orgUnitId: w.units.cityA });
      expect(byName.json.data.possibleDuplicates).toEqual([expect.objectContaining({ matchedOn: ["NAME"] })]);
    } finally {
      await resetMatchers();
    }
  });

  it("reads defaults until configured, and only a tenant-wide manage grant may change them", async () => {
    const fresh = await buildWorld("customers-dup-fresh");
    const freshCeo = await sessionCookie(fresh.ceo, fresh.tenantId);
    const before = await call(getMatchers, "GET", "/x", { cookie: freshCeo });
    expect(before.json.data).toEqual({ matchers: DEFAULT_DUPLICATE_MATCHERS, isDefault: true });

    const body = { phone: true, email: false, address: true, name: true };
    expect((await call(putMatchers, "PUT", "/x", { cookie: await sessionCookie(fresh.cityManagerA, fresh.tenantId), body })).status).toBe(403);
    expect((await call(putMatchers, "PUT", "/x", { cookie: freshCeo, body: { phone: true } })).status).toBe(400);
    const saved = await call(putMatchers, "PUT", "/x", { cookie: freshCeo, body });
    expect(saved.json.data).toEqual({ matchers: body, isDefault: false });
    expect((await call(getMatchers, "GET", "/x", { cookie: freshCeo })).json.data.matchers).toEqual(body);
    const [event] = await auditEvents(fresh.tenantId, "customer.duplicate_matchers_update");
    expect(event.previousValue).toEqual(DEFAULT_DUPLICATE_MATCHERS);
    expect(event.newValue).toEqual(body);
  });

  it("the shared candidate search is usable by other modules (e.g. a lead against customers)", async () => {
    const number = phone();
    const existing = await makeCustomer(w.tenantId, { phoneE164: `+1${number.replace(/\D/g, "")}`, email: `${unique("lead")}@x.test` });
    const candidates = await withTenant(w.tenantId, (tx) =>
      findDuplicateCustomerCandidates(tx, w.tenantId, { phoneE164: `+1${number.replace(/\D/g, "")}`, email: "nobody@x.test" }, DEFAULT_DUPLICATE_MATCHERS),
    );
    expect(candidates).toEqual([{ customerId: existing.id, matchedOn: ["PHONE"] }]);
  });
});

describe("manual resolution", () => {
  async function flaggedPair(creator = ceo, unitA = w.units.cityA, unitB = w.units.cityA) {
    const number = phone();
    const first = (await create(creator, { name: unique("P1 "), phone: number, orgUnitId: unitA })).json.data;
    const second = (await create(ceo, { name: unique("P2 "), phone: number, orgUnitId: unitB })).json.data;
    const [flag] = await flagsFor(w.tenantId, first.id);
    return { first, second, flag };
  }
  const resolve = (cookie: string, flagId: string, body: Record<string, unknown>) =>
    call(resolveFlag, "POST", "/x", { cookie, params: { flagId }, body });

  it("'not a duplicate' sticks: later edits never reopen the pair", async () => {
    const { second, flag } = await flaggedPair();
    const resolved = await resolve(ceo, flag.id, { resolution: "NOT_DUPLICATE", note: "Different people, shared office line" });
    expect(resolved.status).toBe(200);
    expect(resolved.json.data).toMatchObject({ status: "NOT_DUPLICATE", resolvedById: w.ceo.userId, resolutionNote: "Different people, shared office line" });

    await call(patchCustomer, "PATCH", "/x", { cookie: ceo, params: { id: second.id }, body: { name: unique("Renamed ") } });
    const after = await flagsFor(w.tenantId, second.id);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("NOT_DUPLICATE");
    const [event] = await auditEvents(w.tenantId, "customer.duplicate_resolve", flag.id);
    expect(event).toMatchObject({ reason: "Different people, shared office line" });
    expect(event.previousValue).toEqual({ status: "OPEN" });
  });

  it("'confirmed duplicate' only records the decision (no merge), and a decision can be changed once", async () => {
    const { first, second, flag } = await flaggedPair();
    expect((await resolve(ceo, flag.id, { resolution: "CONFIRMED_DUPLICATE" })).json.data.status).toBe("CONFIRMED_DUPLICATE");
    expect((await resolve(ceo, flag.id, { resolution: "CONFIRMED_DUPLICATE" })).status).toBe(409);
    expect((await resolve(ceo, flag.id, { resolution: "NOT_DUPLICATE" })).json.data.status).toBe("NOT_DUPLICATE");
    const stillThere = await withTenant(w.tenantId, (tx) => tx.customer.count({ where: { id: { in: [first.id, second.id] }, archivedAt: null } }));
    expect(stillThere).toBe(2);
    expect((await resolve(ceo, flag.id, { resolution: "MERGED" })).status).toBe(400);
  });

  it("the review queue lists flags by status and per customer", async () => {
    const { first, flag } = await flaggedPair();
    const open = await queue(ceo, { customerId: first.id });
    expect(open.json.data.map((entry: { id: string }) => entry.id)).toEqual([flag.id]);
    await resolve(ceo, flag.id, { resolution: "NOT_DUPLICATE" });
    expect((await queue(ceo, { customerId: first.id })).json.data).toEqual([]);
    expect((await queue(ceo, { customerId: first.id, status: "NOT_DUPLICATE" })).json.data).toHaveLength(1);
    expect((await queue(ceo, { status: "MERGED" })).status).toBe(400);
  });
});

describe("isolation of duplicate information", () => {
  it("a duplicate in another city is flagged, but never revealed to a manager who cannot see it", async () => {
    const number = phone();
    const inB = (await create(cityManagerB, { name: unique("Hidden "), phone: number, orgUnitId: w.units.cityB })).json.data;
    const fromA = await create(cityManagerA, { name: unique("Visible "), phone: number, orgUnitId: w.units.cityA });
    expect(fromA.status).toBe(201);
    expect(fromA.json.data.possibleDuplicates).toEqual([]); // nothing about City B's customer leaks into the response
    expect(JSON.stringify(fromA.json)).not.toContain(inB.id);

    const [flag] = await flagsFor(w.tenantId, inB.id);
    expect(flag.status).toBe("OPEN"); // but it IS flagged for someone who can see both
    expect((await queue(cityManagerA)).json.data.map((entry: { id: string }) => entry.id)).not.toContain(flag.id);
    expect((await queue(cityManagerB)).json.data.map((entry: { id: string }) => entry.id)).not.toContain(flag.id);
    expect((await queue(stateManager)).json.data.map((entry: { id: string }) => entry.id)).toContain(flag.id);
    expect((await queue(ceo)).json.data.map((entry: { id: string }) => entry.id)).toContain(flag.id);

    // Resolving needs authority over BOTH customers; a one-sided manager gets 404, not a hint.
    expect((await call(resolveFlag, "POST", "/x", { cookie: cityManagerA, params: { flagId: flag.id }, body: { resolution: "NOT_DUPLICATE" } })).status).toBe(404);
    expect((await call(resolveFlag, "POST", "/x", { cookie: stateManager, params: { flagId: flag.id }, body: { resolution: "NOT_DUPLICATE" } })).status).toBe(200);
  });

  it("another tenant cannot see or resolve a flag", async () => {
    const number = phone();
    const first = (await create(ceo, { name: unique("T1 "), phone: number, orgUnitId: w.units.cityA })).json.data;
    await create(ceo, { name: unique("T2 "), phone: number, orgUnitId: w.units.cityA });
    const [flag] = await flagsFor(w.tenantId, first.id);
    const foreignCeo = await sessionCookie(other.ceo, other.tenantId);
    expect((await queue(foreignCeo)).json.data.map((entry: { id: string }) => entry.id)).not.toContain(flag.id);
    expect((await call(resolveFlag, "POST", "/x", { cookie: foreignCeo, params: { flagId: flag.id }, body: { resolution: "NOT_DUPLICATE" } })).status).toBe(404);
  });
});
