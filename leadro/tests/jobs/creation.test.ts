import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/v1/jobs/route";
import { withTenant } from "@/server/db";
import { createJobFromLead } from "@/server/jobs";
import { disconnect } from "../authz/fixtures";
import { makeCustomer, makeAddress, makeLead } from "../customers/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-create");
});
afterAll(disconnect);

const create = (cookie: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(createJobRoute, "POST", "/api/v1/jobs", { cookie, body, headers });
const base = () => ({ customerId: w.customerA.id, serviceAddressId: w.customerA.addressId, jobTypeId: w.ids.repairType });

describe("creating a job by hand", () => {
  it("starts at PENDING_ASSIGNMENT with a number, the job type's defaults, its requirements, two history rows, an event and an audit row", async () => {
    const response = await create(w.cookie.dispatcher, { ...base(), description: "No cooling" });
    expect(response.status).toBe(201);
    const job = response.json.data;
    expect(job).toMatchObject({
      status: "PENDING_ASSIGNMENT",
      origin: "MANUAL",
      priority: "HIGH", // the job type's default
      title: "HVAC repair",
      estimatedDurationMinutes: 120,
      orgUnitId: w.units.cityA,
      leadId: null,
      assignments: [],
    });
    expect(job.number).toBeGreaterThan(0);
    expect(job.requirements).toHaveLength(2); // HVAC skill + EPA license, copied from the job type
    expect(job.requirements.every((row: { source: string }) => row.source === "JOB_TYPE")).toBe(true);
    expect(job).not.toHaveProperty("quotedAmountMinor"); // the financial set is opt-in

    const [history, events] = await withTenant(w.tenantId, (tx) =>
      Promise.all([
        tx.jobStatusHistory.findMany({ where: { jobId: job.id }, orderBy: { occurredAt: "asc" } }),
        tx.jobEvent.findMany({ where: { jobId: job.id } }),
      ]),
    );
    expect(history.map((row) => [row.fromStatus, row.toStatus, row.actorType])).toEqual([
      [null, "CREATED", "USER"],
      ["CREATED", "PENDING_ASSIGNMENT", "SYSTEM"],
    ]);
    expect(events.map((event) => event.type)).toEqual(["job.created"]);
    const [audit] = await auditEvents(w.tenantId, "job.create", job.id);
    expect(audit.actorUserId).toBe(w.dispatcher.userId);
  });

  it("snapshots the job type: changing the type later does not change an existing job's requirements", async () => {
    const job = await createJobViaApi(w);
    await withTenant(w.tenantId, (tx) => tx.jobTypeSkill.deleteMany({ where: { jobTypeId: w.ids.repairType, skillId: w.ids.hvac } }));
    try {
      const fetched = await call(getJobRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
      expect(fetched.json.data.requirements).toHaveLength(2);
    } finally {
      await withTenant(w.tenantId, (tx) => tx.jobTypeSkill.create({ data: { tenantId: w.tenantId, jobTypeId: w.ids.repairType, skillId: w.ids.hvac, minLevel: 3 } }));
    }
  });

  it("adds manual requirements on top of the type's, keeping the stricter level", async () => {
    const extraSkill = await withTenant(w.tenantId, (tx) => tx.skill.create({ data: { tenantId: w.tenantId, code: `extra-${Date.now()}`, name: "Extra" } }));
    const job = await createJobViaApi(w, { additionalRequirements: { skills: [{ skillId: extraSkill.id, minLevel: 2 }, { skillId: w.ids.hvac, minLevel: 5 }] } });
    const rows = job.requirements as Array<{ skillId: string | null; minLevel: number | null; source: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.skillId === w.ids.hvac)).toMatchObject({ minLevel: 5, source: "JOB_TYPE" });
    expect(rows.find((row) => row.skillId === extraSkill.id)).toMatchObject({ minLevel: 2, source: "MANUAL" });
    expect((await create(w.cookie.dispatcher, { ...base(), additionalRequirements: { skills: [{ skillId: "nope" }] } })).status).toBe(400);
  });

  it("warns (never blocks) when the estimated duration is longer than the appointment window (§25.2)", async () => {
    const start = new Date(Date.now() + 5 * 86_400_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    const response = await create(w.cookie.dispatcher, { ...base(), appointmentWindow: { start: start.toISOString(), end: end.toISOString() } });
    expect(response.status).toBe(201);
    expect(response.json.data.warnings).toEqual([{ code: "DURATION_EXCEEDS_WINDOW", params: { estimatedDurationMinutes: 120, windowMinutes: 60 } }]);
    const bad = await create(w.cookie.dispatcher, { ...base(), appointmentWindow: { start: end.toISOString(), end: start.toISOString() } });
    expect(bad.status).toBe(400);
  });

  it("is idempotent per Idempotency-Key: a retry returns the same job and creates no second one", async () => {
    const key = `job-${Date.now()}`;
    const first = await create(w.cookie.dispatcher, base(), { "idempotency-key": key });
    const second = await create(w.cookie.dispatcher, base(), { "idempotency-key": key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.data.id).toBe(first.json.data.id);
    const different = await create(w.cookie.dispatcher, { ...base(), title: "Other" }, { "idempotency-key": key });
    expect(different.status).toBe(409);
  });

  it("refuses an archived customer, another customer's address, an unknown job type and unknown fields", async () => {
    const archived = await create(w.cookie.dispatcher, { ...base(), customerId: w.archivedCustomer.id, serviceAddressId: w.archivedCustomer.addressId });
    expect(archived.status).toBe(409);
    expect(archived.json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await create(w.cookie.dispatcher, { ...base(), serviceAddressId: w.customerB.addressId })).json.error.field).toBe("serviceAddressId");
    expect((await create(w.cookie.dispatcher, { ...base(), jobTypeId: "nope" })).json.error.field).toBe("jobTypeId");
    expect((await create(w.cookie.dispatcher, { ...base(), status: "CLOSED" })).status).toBe(400);
    expect((await create(w.cookie.dispatcher, { ...base(), origin: "LEAD_CONVERSION" })).status).toBe(400); // only the leads module creates those
  });

  it("derives the service area from the address, refuses a unit outside the customer's, and accepts one inside it", async () => {
    const outside = await create(w.cookie.dispatcher, { ...base(), orgUnitId: w.units.cityB });
    expect(outside.status).toBe(400);
    expect(outside.json.error.field).toBe("orgUnitId");
    const inside = await create(w.cookie.dispatcher, { ...base(), orgUnitId: w.units.teamA1 });
    expect(inside.status).toBe(201);
    expect(inside.json.data.orgUnitId).toBe(w.units.teamA1);
  });

  it("links a follow-up to a parent job of the same customer only", async () => {
    const parent = await createJobViaApi(w);
    const followUp = await create(w.cookie.dispatcher, { ...base(), origin: "CUSTOMER_FOLLOW_UP", parentJobId: parent.id });
    expect(followUp.status).toBe(201);
    expect(followUp.json.data).toMatchObject({ origin: "CUSTOMER_FOLLOW_UP", parentJobId: parent.id });
    const otherParent = await create(w.cookie.dispatcher, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId, jobTypeId: w.ids.repairType, parentJobId: parent.id });
    expect(otherParent.status).toBe(400);
  });
});

describe("who may create, and what they see back", () => {
  it("answers 403 without jobs.create (technician), 404 for a customer in another city (city manager), 201 for the Dispatcher over the state", async () => {
    expect((await create(w.cookie.techA1, base())).status).toBe(403);
    const crossCity = await create(w.cookie.cityManagerA, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId, jobTypeId: w.ids.repairType });
    expect(crossCity.status).toBe(404);
    expect((await create(w.cookie.dispatcher, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId, jobTypeId: w.ids.repairType })).status).toBe(201);
  });

  it("needs the financial grant for money: the Dispatcher is refused, the CEO may set it, and the Dispatcher still never sees it", async () => {
    const refused = await create(w.cookie.dispatcher, { ...base(), quotedAmountMinor: 25_000 });
    expect(refused.status).toBe(403);
    const byCeo = await create(w.cookie.ceo, { ...base(), quotedAmountMinor: 25_000, currency: "USD" });
    expect(byCeo.status).toBe(201);
    expect(byCeo.json.data).toMatchObject({ quotedAmountMinor: "25000", currency: "USD" });
    const asDispatcher = await call(getJobRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: byCeo.json.data.id } });
    expect(asDispatcher.json.data).not.toHaveProperty("quotedAmountMinor");
    const [audit] = await auditEvents(w.tenantId, "job.create", byCeo.json.data.id);
    expect(JSON.stringify(audit.newValue)).not.toContain("25000");
  });

  it("lists only what the caller's scope covers and shows no job of another tenant", async () => {
    const mine = await createJobViaApi(w);
    const inCityB = await createJobViaApi(w, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId });
    const asCityA = await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { limit: "200" } });
    const ids = asCityA.json.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(inCityB.id);
    expect((await call(getJobRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: inCityB.id } })).status).toBe(404);

    const other = await buildJobsWorld("jobs-create-other");
    const otherJob = await createJobViaApi(other);
    expect((await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: otherJob.id } })).status).toBe(404);
  });
});

describe("createJobFromLead (called by the leads module inside its transaction)", () => {
  const input = async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA, isPrimary: true });
    const leadId = await makeLead(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    return { leadId, customerId: customer.id, serviceAddressId: addressId, jobTypeId: w.ids.repairType };
  };

  it("creates the job in the caller's transaction, origin LEAD_CONVERSION, linked to the lead, and is idempotent per lead", async () => {
    const lead = await input();
    const actor = w.cityManagerA.actor;
    const first = await withTenant(w.tenantId, (tx) => createJobFromLead(tx, actor, { ...lead, description: "From the lead", priority: "URGENT" }));
    expect(first.created).toBe(true);
    const again = await withTenant(w.tenantId, (tx) => createJobFromLead(tx, actor, lead));
    expect(again).toMatchObject({ id: first.id, number: first.number, created: false });

    const stored = await withTenant(w.tenantId, (tx) => tx.job.findMany({ where: { leadId: lead.leadId } }));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ origin: "LEAD_CONVERSION", status: "PENDING_ASSIGNMENT", priority: "URGENT", description: "From the lead", orgUnitId: w.units.cityA });
    expect((await auditEvents(w.tenantId, "job.create", first.id))[0].actorUserId).toBe(actor.userId);
  });

  it("rolls back with the caller's transaction (no job, no number-independent leftovers)", async () => {
    const lead = await input();
    await expect(
      withTenant(w.tenantId, async (tx) => {
        await createJobFromLead(tx, w.cityManagerA.actor, lead);
        throw new Error("conversion failed later");
      }),
    ).rejects.toThrow("conversion failed later");
    expect(await withTenant(w.tenantId, (tx) => tx.job.count({ where: { leadId: lead.leadId } }))).toBe(0);
  });

  it("converts once when two requests race for the same lead", async () => {
    const lead = await input();
    const results = await Promise.all([
      withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, lead)),
      withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, lead)),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].id).toBe(results[1].id);
  });

  it("refuses an archived customer, a customer that is not the lead's, an unknown lead and an inactive job type", async () => {
    const archivedLeadId = await makeLead(w.tenantId, w.archivedCustomer.id, { orgUnitId: w.units.cityA });
    await expect(
      withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, { leadId: archivedLeadId, customerId: w.archivedCustomer.id, serviceAddressId: w.archivedCustomer.addressId, jobTypeId: w.ids.repairType })),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    const lead = await input();
    await expect(withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, { ...lead, customerId: w.customerA.id, serviceAddressId: w.customerA.addressId }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", field: "customerId" });
    await expect(withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, { ...lead, leadId: "nope" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, { ...lead, jobTypeId: "nope" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", field: "jobTypeId" });
  });

  it("falls back to the lead's unit when neither the address nor the customer has one", async () => {
    const customer = await makeCustomer(w.tenantId, {});
    const addressId = await makeAddress(w.tenantId, customer.id, { isPrimary: true });
    const leadId = await makeLead(w.tenantId, customer.id, { orgUnitId: w.units.cityB });
    const result = await withTenant(w.tenantId, (tx) => createJobFromLead(tx, w.cityManagerA.actor, { leadId, customerId: customer.id, serviceAddressId: addressId, jobTypeId: w.ids.repairType }));
    const job = await withTenant(w.tenantId, (tx) => tx.job.findUniqueOrThrow({ where: { id: result.id } }));
    expect(job.orgUnitId).toBe(w.units.cityB);
  });
});
