import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listDuplicatesRoute } from "@/app/api/v1/leads/duplicates/route";
import { POST as resolveRoute } from "@/app/api/v1/leads/duplicates/[flagId]/resolve/route";
import { POST as linkRoute } from "@/app/api/v1/leads/[id]/link-customer/route";
import { withTenant } from "@/server/db";
import { createLead, createLeadSchema, updateLead, updateLeadSchema } from "@/server/leads";
import { disconnect } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { call, contextFor } from "../org/org-helpers";
import { buildLeadWorld, intake, uniquePhone, type LeadWorld } from "./fixtures";

let w: LeadWorld;

const create = (actor: LeadWorld["ceo"]["actor"], fields: Record<string, unknown>) =>
  createLead(actor, contextFor(actor), createLeadSchema.parse({ contactName: "Dup Caller", orgUnitId: w.units.cityA, ...fields }));
const flagsOf = (leadId: string) =>
  withTenant(w.tenantId, (tx) =>
    tx.duplicateFlag.findMany({ where: { tenantId: w.tenantId, OR: [{ leadId }, { otherLeadId: leadId }] }, orderBy: { detectedAt: "asc" } }),
  );
const total = (table: "lead" | "customer") => withTenant(w.tenantId, (tx) => (table === "lead" ? tx.lead.count() : tx.customer.count()));

beforeAll(async () => {
  w = await buildLeadWorld("leads-dups");
});
afterAll(disconnect);

describe("lead duplicate detection (§6.4)", () => {
  it("flags a recent lead with the same phone, never merges and never blocks the intake", async () => {
    const phone = uniquePhone();
    const first = await intake(w, w.stateManager.actor, { contactPhone: phone });
    const before = await total("lead");
    const second = await create(w.stateManager.actor, { contactPhone: phone });
    expect(await total("lead")).toBe(before + 1); // created, not merged
    expect(second.data.possibleDuplicates).toEqual([
      expect.objectContaining({ kind: "LEAD_LEAD", otherId: first, matchedOn: ["PHONE"] }),
    ]);
    const flags = await flagsOf(String(second.data.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "LEAD_LEAD", status: "OPEN" });
    expect(flags[0].leadId! < flags[0].otherLeadId!).toBe(true); // pair stored in sorted order
  });

  it("matches on email and on a complete address, and reports every matched field", async () => {
    const address = { addressLine1: "9 Oak Ave", addressCity: "Springfield", addressRegion: "IL", addressPostalCode: "62702" };
    const first = await intake(w, w.stateManager.actor, { contactEmail: "same@dups.test", ...address });
    const second = await create(w.stateManager.actor, { contactEmail: "same@dups.test", ...address, addressLine1: "9 oak ave." });
    expect(second.data.possibleDuplicates).toEqual([
      expect.objectContaining({ kind: "LEAD_LEAD", otherId: first, matchedOn: expect.arrayContaining(["EMAIL", "ADDRESS"]) }),
    ]);
  });

  it("does not flag leads that merely look alike: name matching is off by default, and an incomplete address never matches", async () => {
    await intake(w, w.stateManager.actor, { contactName: "Common Name", addressLine1: "1 Short St" });
    const second = await create(w.stateManager.actor, { contactName: "Common Name", addressLine1: "1 Short St" });
    expect(second.data.possibleDuplicates).toEqual([]);
  });

  it("only compares with recent leads (the §6.4 'recent history' window)", async () => {
    const phone = uniquePhone();
    const old = await intake(w, w.stateManager.actor, { contactPhone: phone });
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - 60 * 86_400_000) } }));
    const fresh = await create(w.stateManager.actor, { contactPhone: phone });
    expect(fresh.data.possibleDuplicates).toEqual([]);
  });

  it("flags a lead whose contact matches an existing customer (reusing the customers matcher), archived customers included", async () => {
    const phone = uniquePhone();
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, phoneE164: phone, archived: true });
    const lead = await create(w.stateManager.actor, { contactPhone: phone });
    expect(lead.data.possibleDuplicates).toEqual([
      expect.objectContaining({ kind: "LEAD_CUSTOMER", otherId: customer.id, matchedOn: ["PHONE"] }),
    ]);
    expect((await flagsOf(String(lead.data.id)))[0]).toMatchObject({ kind: "LEAD_CUSTOMER", customerId: customer.id });
  });

  it("does not call the customer a lead is already linked to a duplicate of it", async () => {
    const phone = uniquePhone();
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, phoneE164: phone });
    const lead = await create(w.stateManager.actor, { contactPhone: phone, customerId: customer.id });
    expect(lead.data.possibleDuplicates).toEqual([]);
  });

  it("flags but does not reveal a duplicate outside the caller's scope", async () => {
    const phone = uniquePhone();
    const hidden = await intake(w, w.stateManager.actor, { contactPhone: phone, orgUnitId: w.units.cityB });
    const created = await create(w.cityManagerA.actor, { contactPhone: phone });
    expect(created.data.possibleDuplicates).toEqual([]); // City A's manager must not learn about City B's lead
    expect(JSON.stringify(created.data)).not.toContain(hidden);
    const flags = await flagsOf(String(created.data.id));
    expect(flags).toHaveLength(1); // the system still flagged it, for someone with the wider scope
    const queueA = await call(listDuplicatesRoute, "GET", "/api/v1/leads/duplicates", { cookie: w.cookies.cityManagerA });
    expect(queueA.json.data.map((row: { id: string }) => row.id)).not.toContain(flags[0].id);
    const queueState = await call(listDuplicatesRoute, "GET", "/api/v1/leads/duplicates", { cookie: w.cookies.stateManager });
    expect(queueState.json.data.map((row: { id: string }) => row.id)).toContain(flags[0].id);
  });

  it("re-checks duplicates when a phone number is edited", async () => {
    const phone = uniquePhone();
    const first = await intake(w, w.stateManager.actor, { contactPhone: phone });
    const second = await intake(w, w.stateManager.actor);
    const updated = await updateLead(w.stateManager.actor, contextFor(w.stateManager.actor), second, updateLeadSchema.parse({ contactPhone: phone }));
    expect(updated.possibleDuplicates).toEqual([expect.objectContaining({ otherId: first })]);
  });
});

describe("resolving duplicate flags by a person", () => {
  it("records 'not a duplicate' and never flags the pair again", async () => {
    const phone = uniquePhone();
    const first = await intake(w, w.stateManager.actor, { contactPhone: phone });
    const second = await create(w.stateManager.actor, { contactPhone: phone });
    const [flag] = await flagsOf(String(second.data.id));

    const resolved = await call(resolveRoute, "POST", `/api/v1/leads/duplicates/${flag.id}/resolve`, {
      cookie: w.cookies.stateManager,
      params: { flagId: flag.id },
      body: { resolution: "NOT_DUPLICATE", note: "Two people sharing a phone" },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.json.data).toMatchObject({ status: "NOT_DUPLICATE", resolutionNote: "Two people sharing a phone", resolvedById: w.stateManager.userId });

    // An edit re-runs detection: the decided pair stays decided.
    const again = await updateLead(w.stateManager.actor, contextFor(w.stateManager.actor), String(second.data.id), updateLeadSchema.parse({ contactName: "Renamed", contactPhone: phone }));
    expect(again.possibleDuplicates).toEqual([]);
    expect((await flagsOf(first))[0].status).toBe("NOT_DUPLICATE");

    const repeat = await call(resolveRoute, "POST", `/api/v1/leads/duplicates/${flag.id}/resolve`, {
      cookie: w.cookies.stateManager,
      params: { flagId: flag.id },
      body: { resolution: "NOT_DUPLICATE" },
    });
    expect(repeat.status).toBe(409);
  });

  it("is refused to a caller who cannot edit both leads", async () => {
    const phone = uniquePhone();
    await intake(w, w.stateManager.actor, { contactPhone: phone, orgUnitId: w.units.cityB });
    const created = await create(w.stateManager.actor, { contactPhone: phone });
    const [flag] = await flagsOf(String(created.data.id));
    const result = await call(resolveRoute, "POST", `/api/v1/leads/duplicates/${flag.id}/resolve`, {
      cookie: w.cookies.cityManagerA,
      params: { flagId: flag.id },
      body: { resolution: "CONFIRMED_DUPLICATE" },
    });
    expect(result.status).toBe(404);
  });

  it("linking a lead to the matching customer closes the lead-customer flag as confirmed", async () => {
    const phone = uniquePhone();
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, phoneE164: phone });
    const address = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const lead = await create(w.stateManager.actor, { contactPhone: phone });
    const leadId = String(lead.data.id);
    const linked = await call(linkRoute, "POST", `/api/v1/leads/${leadId}/link-customer`, {
      cookie: w.cookies.stateManager,
      params: { id: leadId },
      body: { customerId: customer.id, customerAddressId: address },
    });
    expect(linked.status).toBe(200);
    expect(linked.json.data).toMatchObject({ customerId: customer.id, customerAddressId: address });
    expect((await flagsOf(leadId))[0]).toMatchObject({ status: "CONFIRMED_DUPLICATE", resolvedById: w.stateManager.userId });
  });

  it("refuses to link an archived customer, another customer's address or an invisible customer", async () => {
    const lead = String((await create(w.stateManager.actor, { contactPhone: uniquePhone() })).data.id);
    const archived = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, archived: true });
    const link = (cookie: string, body: Record<string, unknown>) =>
      call(linkRoute, "POST", `/api/v1/leads/${lead}/link-customer`, { cookie, params: { id: lead }, body });
    expect((await link(w.cookies.stateManager, { customerId: archived.id })).status).toBe(409);

    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const other = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const foreign = await makeAddress(w.tenantId, other.id);
    expect((await link(w.cookies.stateManager, { customerId: customer.id, customerAddressId: foreign })).status).toBe(400);

    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    expect((await link(w.cookies.cityManagerA, { customerId: inB.id })).status).toBe(404);
  });
});
