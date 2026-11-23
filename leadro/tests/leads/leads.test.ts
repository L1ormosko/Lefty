import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listLeadsRoute, POST as createLeadRoute } from "@/app/api/v1/leads/route";
import { GET as getLeadRoute, PATCH as patchLeadRoute } from "@/app/api/v1/leads/[id]/route";
import { POST as statusRoute } from "@/app/api/v1/leads/[id]/status/route";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError } from "@/server/core";
import { withTenant } from "@/server/db";
import { createLead, createLeadSchema, getLead, listLeads, listLeadsQuerySchema } from "@/server/leads";
import { disconnect } from "../authz/fixtures";
import { assignLead as assignDirect, makeAddress, makeCustomer } from "../customers/fixtures";
import { auditEvents, call, contextFor } from "../org/org-helpers";
import { buildLeadWorld, forceStatus, intake, leadRow, statusHistory, uniquePhone, type LeadWorld } from "./fixtures";

let w: LeadWorld;
const apiLead = (fields: Record<string, unknown> = {}) => ({ contactName: "Api Caller", contactPhone: uniquePhone(), orgUnitId: w.units.cityA, ...fields });

beforeAll(async () => {
  w = await buildLeadWorld("leads-core");
});
afterAll(disconnect);

describe("lead intake (§6.2)", () => {
  it("creates a NEW lead with a number, an initial history row and an audit event", async () => {
    const leadId = await intake(w, w.stateManager.actor, { campaign: "spring", priority: "HIGH", requestedWork: "Leaking tap" });
    const row = await leadRow(w.tenantId, leadId);
    expect(row.status).toBe("NEW");
    expect(row.number).toBeGreaterThan(0);
    expect(row.priority).toBe("HIGH");
    expect(row.createdById).toBe(w.stateManager.userId);
    expect(row.contactPhoneE164).toMatch(/^\+1/);
    const history = await statusHistory(w.tenantId, leadId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: "NEW", actorUserId: w.stateManager.userId });
    expect((await auditEvents(w.tenantId, "lead.create", leadId)).length).toBe(1);
  });

  it("needs some way to reach the customer", () => {
    expect(createLeadSchema.safeParse({ orgUnitId: w.units.cityA, requestedWork: "Something" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ contactEmail: "a@b.test" }).success).toBe(true);
  });

  it("accepts an incomplete address (§25.1) and a phone typed with punctuation", async () => {
    const leadId = await intake(w, w.stateManager.actor, { addressLine1: "5 Elm", contactPhone: "(202) 555-0134" });
    const row = await leadRow(w.tenantId, leadId);
    expect(row.addressNormalizedKey).toBeNull();
    expect(row.contactPhoneE164).toBe("+12025550134");
  });

  it("derives the address matching key only from a complete address", async () => {
    const leadId = await intake(w, w.stateManager.actor, {
      addressLine1: "12 Main St.",
      addressCity: "Springfield",
      addressRegion: "IL",
      addressPostalCode: "62701",
    });
    expect((await leadRow(w.tenantId, leadId)).addressNormalizedKey).toBe("12 main st||springfield|il|62701|us");
  });

  it("files the lead under a unit only for someone with the permission over that unit", async () => {
    await expect(intake(w, w.cityManagerB.actor, { orgUnitId: w.units.cityA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(intake(w, w.cityManagerA.actor, { orgUnitId: w.units.cityA })).resolves.toBeTruthy();
  });

  it("makes a lead without a unit tenant-level: only a tenant-wide grant may create it", async () => {
    const input = createLeadSchema.parse({ contactName: "No Unit", contactPhone: uniquePhone() });
    await expect(createLead(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), input)).rejects.toBeInstanceOf(ForbiddenError);
    const created = await createLead(w.ceo.actor, contextFor(w.ceo.actor), input);
    expect(created.data.orgUnitId).toBeNull();
  });

  it("refuses an archived customer and checks the address belongs to the customer", async () => {
    const archived = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, archived: true });
    await expect(intake(w, w.stateManager.actor, { customerId: archived.id })).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const other = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const foreignAddress = await makeAddress(w.tenantId, other.id);
    await expect(intake(w, w.stateManager.actor, { customerId: customer.id, customerAddressId: foreignAddress })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      field: "customerAddressId",
    });
    const ownAddress = await makeAddress(w.tenantId, customer.id);
    await expect(intake(w, w.stateManager.actor, { customerId: customer.id, customerAddressId: ownAddress })).resolves.toBeTruthy();
  });

  it("rejects an unknown, an inactive source and an unknown job type", async () => {
    await expect(intake(w, w.stateManager.actor, { sourceCode: "nope" })).rejects.toMatchObject({ field: "sourceCode" });
    await expect(intake(w, w.stateManager.actor, { jobTypeId: "missing" })).rejects.toMatchObject({ field: "jobTypeId" });
  });

  it("is idempotent per (source, externalId): a duplicate webhook returns the lead it already created (§25.1)", async () => {
    const input = createLeadSchema.parse({ ...apiLead(), sourceCode: w.sourceCode, externalId: "crm-9001" });
    const first = await createLead(w.stateManager.actor, contextFor(w.stateManager.actor), input);
    const second = await createLead(w.stateManager.actor, contextFor(w.stateManager.actor), input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.data.id).toBe(first.data.id);
    const rows = await withTenant(w.tenantId, (tx) => tx.lead.count({ where: { tenantId: w.tenantId, externalId: "crm-9001" } }));
    expect(rows).toBe(1);
  });

  it("does not reveal an existing lead of the same external id to somebody who cannot see it", async () => {
    const input = createLeadSchema.parse({ ...apiLead({ orgUnitId: w.units.cityB }), sourceCode: w.sourceCode, externalId: "crm-9002" });
    await createLead(w.cityManagerB.actor, contextFor(w.cityManagerB.actor), input);
    const sameOrigin = createLeadSchema.parse({ ...apiLead({ orgUnitId: w.units.cityA }), sourceCode: w.sourceCode, externalId: "crm-9002" });
    await expect(createLead(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), sameOrigin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays the stored response for the same Idempotency-Key (API)", async () => {
    const headers = { "idempotency-key": `intake-${Date.now()}` };
    const body = apiLead({ requestedWork: "Retry me" });
    const first = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.stateManager, body, headers });
    const second = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.stateManager, body, headers });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.data.id).toBe(first.json.data.id);
    const different = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.stateManager, body: apiLead(), headers });
    expect(different.status).toBe(409);
  });

  it("answers 200 (not 201) when a repeated external id returns the existing lead", async () => {
    const body = { ...apiLead(), sourceCode: w.sourceCode, externalId: "crm-9003" };
    const first = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.stateManager, body });
    const second = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.stateManager, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.data.id).toBe(first.json.data.id);
  });

  it("tells Lead Operations of the unit that a lead needs an owner", async () => {
    const leadId = await intake(w, w.cityManagerA.actor);
    const notes = await withTenant(w.tenantId, (tx) =>
      tx.notification.findMany({ where: { tenantId: w.tenantId, eventType: "lead.needs_owner", targetId: leadId } }),
    );
    const recipients = notes.map((note) => note.recipientId);
    expect(recipients).toContain(w.leadOps.userId);
    expect(recipients).not.toContain(w.cityManagerA.userId); // the creator is not told about their own action
  });

  it("is denied to a Technician (no leads.create)", async () => {
    const result = await call(createLeadRoute, "POST", "/api/v1/leads", { cookie: w.cookies.techA1, body: apiLead() });
    expect(result.status).toBe(403);
  });
});

describe("lead visibility by scope", () => {
  let inA: string;
  let inB: string;
  let owned: string;
  let qualified: string;

  beforeAll(async () => {
    inA = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityA, contactName: "Scope A" });
    inB = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityB, contactName: "Scope B" });
    owned = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityA, contactName: "Owned By Tech" });
    await assignDirect(w.tenantId, owned, w.techA1.employeeId as string);
    qualified = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityA, contactName: "Dispatch Ready" });
    await forceStatus(w.tenantId, qualified, "QUALIFIED");
  });

  const ids = async (actor: LeadWorld["ceo"]["actor"], query: Record<string, string> = {}) =>
    (await listLeads(actor, listLeadsQuerySchema.parse({ limit: "200", ...query }))).data.map((row) => row.id);

  it("shows a city manager only the leads of their city", async () => {
    const seen = await ids(w.cityManagerA.actor);
    expect(seen).toContain(inA);
    expect(seen).not.toContain(inB);
  });

  it("shows a Technician only the leads assigned to them (ASSIGNED scope)", async () => {
    expect(await ids(w.techA1.actor)).toEqual([owned]);
    expect(await ids(w.techB.actor)).toEqual([]);
  });

  it("shows a Dispatcher only leads that reached dispatch (record-set grant)", async () => {
    const seen = await ids(w.dispatcher.actor);
    expect(seen).toContain(qualified);
    expect(seen).not.toContain(inA);
    await expect(getLead(w.dispatcher.actor, inA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(w.dispatcher.actor, qualified)).resolves.toMatchObject({ id: qualified });
  });

  it("answers 404 for a lead outside the caller's scope and for another tenant", async () => {
    const outside = await call(getLeadRoute, "GET", `/api/v1/leads/${inB}`, { cookie: w.cookies.cityManagerA, params: { id: inB } });
    expect(outside.status).toBe(404);
    const other = await buildLeadWorld("leads-other-tenant");
    const crossTenant = await call(getLeadRoute, "GET", `/api/v1/leads/${inA}`, { cookie: other.cookies.ceo, params: { id: inA } });
    expect(crossTenant.status).toBe(404);
    expect((await listLeads(other.ceo.actor, listLeadsQuerySchema.parse({}))).data).toEqual([]);
  });

  it("filters the list and keeps the scope", async () => {
    expect(await ids(w.cityManagerA.actor, { q: "Scope A" })).toEqual([inA]);
    expect(await ids(w.cityManagerA.actor, { q: "Scope B" })).toEqual([]);
    expect(await ids(w.stateManager.actor, { orgUnitId: w.units.cityB, status: "NEW" })).toContain(inB);
    expect(await ids(w.stateManager.actor, { assigned: "true" })).toContain(owned);
    expect(await ids(w.stateManager.actor, { assigned: "false" })).not.toContain(owned);
    expect(await ids(w.stateManager.actor, { assigneeEmployeeId: w.techA1.employeeId as string })).toEqual([owned]);
  });

  it("includes nextStatuses on a single lead", async () => {
    const lead = await getLead(w.stateManager.actor, inA);
    expect(lead.nextStatuses).toEqual(expect.arrayContaining(["UNASSIGNED", "DUPLICATE", "CANCELLED"]));
    expect(lead.nextStatuses).not.toContain("ASSIGNED");
  });
});

describe("editing leads and Technician write limits", () => {
  let leadId: string;
  beforeAll(async () => {
    leadId = await intake(w, w.stateManager.actor, { contactName: "Editable" });
    await assignDirect(w.tenantId, leadId, w.techA1.employeeId as string);
    await forceStatus(w.tenantId, leadId, "ASSIGNED");
  });

  it("lets a manager edit content and audits the change", async () => {
    const result = await call(patchLeadRoute, "PATCH", `/api/v1/leads/${leadId}`, {
      cookie: w.cookies.stateManager,
      params: { id: leadId },
      body: { notes: "Call after 5", priority: "URGENT" },
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ notes: "Call after 5", priority: "URGENT" });
    const events = await auditEvents(w.tenantId, "lead.update", leadId);
    expect(events[0].newValue).toMatchObject({ notes: "Call after 5", priority: "URGENT" });
  });

  it("refuses a Technician any content change (status-only grant)", async () => {
    for (const body of [{ notes: "x" }, { priority: "LOW" }, { contactPhone: uniquePhone() }, { quotedAmountMinor: 100 }, { nextFollowUpAt: new Date().toISOString() }]) {
      const result = await call(patchLeadRoute, "PATCH", `/api/v1/leads/${leadId}`, { cookie: w.cookies.techA1, params: { id: leadId }, body });
      expect(result.status, JSON.stringify(body)).toBe(403);
    }
  });

  it("lets the assigned Technician change the status, but not mark a duplicate", async () => {
    const moved = await call(statusRoute, "POST", `/api/v1/leads/${leadId}/status`, {
      cookie: w.cookies.techA1,
      params: { id: leadId },
      body: { status: "CONTACT_ATTEMPTED" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.data.status).toBe("CONTACT_ATTEMPTED");

    const other = await intake(w, w.stateManager.actor);
    const duplicate = await call(statusRoute, "POST", `/api/v1/leads/${leadId}/status`, {
      cookie: w.cookies.techA1,
      params: { id: leadId },
      body: { status: "DUPLICATE", duplicateOfLeadId: other },
    });
    expect(duplicate.status).toBe(403);
    expect((await leadRow(w.tenantId, leadId)).status).toBe("CONTACT_ATTEMPTED");
  });

  it("does not let another Technician touch the lead (404, not 403)", async () => {
    const result = await call(statusRoute, "POST", `/api/v1/leads/${leadId}/status`, {
      cookie: w.cookies.techB,
      params: { id: leadId },
      body: { status: "CONTACTED" },
    });
    expect(result.status).toBe(404);
  });

  it("refuses to edit a closed or archived lead", async () => {
    const closed = await intake(w, w.stateManager.actor);
    await forceStatus(w.tenantId, closed, "CANCELLED");
    const result = await call(patchLeadRoute, "PATCH", `/api/v1/leads/${closed}`, { cookie: w.cookies.stateManager, params: { id: closed }, body: { notes: "late" } });
    expect(result.status).toBe(409);
  });

  it("keeps the status out of PATCH (it has its own endpoint) and lists a Technician's leads through the API", async () => {
    const result = await call(patchLeadRoute, "PATCH", `/api/v1/leads/${leadId}`, { cookie: w.cookies.stateManager, params: { id: leadId }, body: { status: "LOST" } });
    expect(result.status).toBe(400);
    const list = await call(listLeadsRoute, "GET", "/api/v1/leads", { cookie: w.cookies.techA1 });
    expect(list.status).toBe(200);
    const listed = list.json.data.map((row: { id: string }) => row.id);
    expect(listed).toContain(leadId);
    expect(listed).toHaveLength(2); // this lead and the one owned in the visibility block: nothing else of the tenant
  });
});
