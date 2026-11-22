import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as convertRoute } from "@/app/api/v1/leads/[id]/convert/route";
import { nextNumber } from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateJobFromLeadInput } from "@/server/leads/job-conversion-port";
import { disconnect } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { activeAssignments, buildLeadWorld, forceStatus, intake, leadRow, statusHistory, type LeadWorld } from "./fixtures";

/**
 * The jobs module is built in parallel, so these tests stand in for `createJobFromLead` with a double that inserts a real
 * Job row inside the conversion's own transaction (which is what the real one must do). Mocking the port file
 * is the documented wiring seam (`job-conversion-port.ts`).
 */
const port = vi.hoisted(() => ({ calls: [] as unknown[], failWith: null as Error | null }));

vi.mock("@/server/leads/job-conversion-port", () => ({
  createJobFromLead: async (
    tx: import("@/server/db").TenantTx,
    actor: { tenantId: string; userId: string },
    input: CreateJobFromLeadInput,
  ) => {
    port.calls.push(input);
    if (port.failWith) throw port.failWith;
    const address = await tx.customerAddress.findFirstOrThrow({ where: { id: input.serviceAddressId, tenantId: actor.tenantId } });
    const job = await tx.job.create({
      data: {
        tenantId: actor.tenantId,
        number: await (await import("@/server/core")).nextNumber(tx, actor.tenantId, "job"),
        customerId: input.customerId,
        serviceAddressId: input.serviceAddressId,
        jobTypeId: input.jobTypeId,
        orgUnitId: address.orgUnitId as string,
        leadId: input.leadId,
        origin: "LEAD_CONVERSION",
        title: "From lead",
        description: input.description ?? null,
        priority: input.priority ?? "NORMAL",
        estimatedDurationMinutes: 60,
        createdById: actor.userId,
      },
    });
    return { id: job.id, number: job.number };
  },
}));

let w: LeadWorld;
let jobTypeId: string;

/** A QUALIFIED lead with a customer, address and job type, ready to convert. */
async function readyLead(overrides: { customer?: boolean; address?: boolean; jobType?: boolean } = {}) {
  const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
  const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
  const leadId = await intake(w, w.stateManager.actor, {
    requestedWork: "Replace water heater",
    priority: "HIGH",
    ...(overrides.customer === false ? {} : { customerId: customer.id }),
    ...(overrides.customer === false || overrides.address === false ? {} : { customerAddressId: addressId }),
    ...(overrides.jobType === false ? {} : { jobTypeId }),
  });
  await forceStatus(w.tenantId, leadId, "QUALIFIED");
  return { leadId, customer, addressId };
}

const convert = (cookie: string, leadId: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call(convertRoute, "POST", `/api/v1/leads/${leadId}/convert`, { cookie, params: { id: leadId }, body, headers });
const jobsOf = (leadId: string) => withTenant(w.tenantId, (tx) => tx.job.findMany({ where: { tenantId: w.tenantId, leadId } }));

beforeAll(async () => {
  w = await buildLeadWorld("leads-convert");
  jobTypeId = await withTenant(w.tenantId, async (tx) => {
    const type = await tx.jobType.create({ data: { tenantId: w.tenantId, code: "conv-type", name: "Conversion type", category: "repair", defaultDurationMinutes: 60 } });
    await nextNumber(tx, w.tenantId, "job"); // exercise the shared counter once, as the real jobs module would
    return type.id;
  });
});
afterAll(disconnect);
beforeEach(() => {
  port.calls.length = 0;
  port.failWith = null;
});

describe("lead conversion (§6.3, §7.1)", () => {
  it("creates the job and marks the lead CONVERTED in one step", async () => {
    const { leadId, customer, addressId } = await readyLead();
    const result = await convert(w.cookies.stateManager, leadId);
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ leadId, status: "CONVERTED", replayed: false, job: { number: expect.any(Number) } });

    const jobs = await jobsOf(leadId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ customerId: customer.id, serviceAddressId: addressId, origin: "LEAD_CONVERSION", priority: "HIGH", description: "Replace water heater" });
    expect(result.json.data.job.id).toBe(jobs[0].id);
    expect((await leadRow(w.tenantId, leadId)).status).toBe("CONVERTED");
    const history = await statusHistory(w.tenantId, leadId);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "QUALIFIED", toStatus: "CONVERTED", reason: expect.stringContaining("converted to job") });
    expect((await auditEvents(w.tenantId, "lead.convert", leadId))[0].newValue).toMatchObject({ jobId: jobs[0].id });
  });

  it("passes the contract fields to the jobs module and lets the request override the lead's values", async () => {
    const { leadId, customer, addressId } = await readyLead();
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    await convert(w.cookies.stateManager, leadId, {
      description: "Override text",
      priority: "URGENT",
      appointmentWindowStart: start.toISOString(),
      appointmentWindowEnd: end.toISOString(),
    });
    expect(port.calls).toEqual([
      { leadId, customerId: customer.id, serviceAddressId: addressId, jobTypeId, description: "Override text", priority: "URGENT", appointmentWindow: { start, end } },
    ]);
  });

  it("ends the owner's assignment: ASSIGNED access does not outlive the lead", async () => {
    const { leadId } = await readyLead();
    await withTenant(w.tenantId, (tx) => tx.leadAssignment.create({ data: { tenantId: w.tenantId, leadId, employeeId: w.techA1.employeeId as string } }));
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(1);
    await convert(w.cookies.stateManager, leadId);
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);
  });

  it("rolls everything back when the job cannot be created (one transaction)", async () => {
    const { leadId } = await readyLead({ customer: false });
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    port.failWith = new Error("jobs module exploded");
    const result = await convert(w.cookies.stateManager, leadId, { customerId: customer.id, serviceAddressId: addressId, jobTypeId });
    expect(result.status).toBe(500);
    const row = await leadRow(w.tenantId, leadId);
    expect(row.status).toBe("QUALIFIED");
    expect(row.customerId).toBeNull(); // the customer link made for the conversion was rolled back too
    expect(await jobsOf(leadId)).toHaveLength(0);
    expect(await statusHistory(w.tenantId, leadId)).toHaveLength(1);
  });

  it("links the lead to the customer named in the request", async () => {
    const { leadId } = await readyLead({ customer: false });
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const result = await convert(w.cookies.stateManager, leadId, { customerId: customer.id, serviceAddressId: addressId });
    expect(result.status).toBe(200);
    expect(await leadRow(w.tenantId, leadId)).toMatchObject({ customerId: customer.id, customerAddressId: addressId, status: "CONVERTED" });
  });

  it("asks for what is missing instead of guessing", async () => {
    const noCustomer = await readyLead({ customer: false });
    expect((await convert(w.cookies.stateManager, noCustomer.leadId)).json.error.field).toBe("customerId");
    const noAddress = await readyLead({ address: false });
    expect((await convert(w.cookies.stateManager, noAddress.leadId)).json.error.field).toBe("serviceAddressId");
    const noType = await readyLead({ jobType: false });
    const missingType = await convert(w.cookies.stateManager, noType.leadId);
    expect(missingType.status).toBe(400);
    expect(missingType.json.error.field).toBe("jobTypeId");
    expect(port.calls).toHaveLength(0);
    // ... and succeeds once it is supplied.
    expect((await convert(w.cookies.stateManager, noType.leadId, { jobTypeId })).status).toBe(200);
  });

  it("refuses an archived customer, another customer's address and a different customer than the lead's", async () => {
    const { leadId, customer } = await readyLead();
    await withTenant(w.tenantId, (tx) => tx.customer.update({ where: { id: customer.id }, data: { archivedAt: new Date() } }));
    expect((await convert(w.cookies.stateManager, leadId)).status).toBe(409);

    const second = await readyLead();
    const other = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const foreignAddress = await makeAddress(w.tenantId, other.id);
    expect((await convert(w.cookies.stateManager, second.leadId, { serviceAddressId: foreignAddress })).status).toBe(400);
    expect((await convert(w.cookies.stateManager, second.leadId, { customerId: other.id })).status).toBe(400);
    expect(await jobsOf(second.leadId)).toHaveLength(0);
  });

  it("only converts leads at or after qualification, never closed or archived ones", async () => {
    const early = await readyLead();
    await forceStatus(w.tenantId, early.leadId, "ASSIGNED");
    expect((await convert(w.cookies.stateManager, early.leadId)).status).toBe(409);
    await forceStatus(w.tenantId, early.leadId, "LOST");
    expect((await convert(w.cookies.stateManager, early.leadId)).status).toBe(409);
    const archived = await readyLead();
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: archived.leadId }, data: { archivedAt: new Date() } }));
    expect((await convert(w.cookies.stateManager, archived.leadId)).status).toBe(409);
    expect(port.calls).toHaveLength(0);
  });

  it("converts only once: a retry returns the same job", async () => {
    const { leadId } = await readyLead();
    const first = await convert(w.cookies.stateManager, leadId);
    const second = await convert(w.cookies.stateManager, leadId);
    expect(second.status).toBe(200);
    expect(second.json.data).toMatchObject({ replayed: true, job: first.json.data.job });
    expect(port.calls).toHaveLength(1);
    expect(await jobsOf(leadId)).toHaveLength(1);
  });

  it("lets a Dispatcher convert a lead that reached dispatch, but not one that has not (404)", async () => {
    const { leadId } = await readyLead();
    expect((await convert(w.cookies.dispatcher, leadId)).status).toBe(200);
    const early = await readyLead();
    await forceStatus(w.tenantId, early.leadId, "CONTACTED");
    expect((await convert(w.cookies.dispatcher, early.leadId)).status).toBe(404);
  });

  it("is refused to people who cannot create jobs: Lead Operations and Technicians (403)", async () => {
    const { leadId } = await readyLead();
    expect((await convert(w.cookies.leadOps, leadId)).status).toBe(403);
    // A Technician who owns the lead can see it but holds no jobs.create: 403. One who does not own it cannot even see it: 404.
    expect((await convert(w.cookies.techA1, leadId)).status).toBe(404);
    await withTenant(w.tenantId, (tx) => tx.leadAssignment.create({ data: { tenantId: w.tenantId, leadId, employeeId: w.techA1.employeeId as string } }));
    expect((await convert(w.cookies.techA1, leadId)).status).toBe(403);
    expect(await jobsOf(leadId)).toHaveLength(0);
  });

  it("does not convert a lead outside the caller's scope (404)", async () => {
    const { leadId } = await readyLead();
    expect((await convert(w.cookies.cityManagerB, leadId)).status).toBe(404);
  });

  it("replays the stored response for the same Idempotency-Key", async () => {
    const { leadId } = await readyLead();
    const headers = { "idempotency-key": `convert-${Date.now()}` };
    const first = await convert(w.cookies.stateManager, leadId, {}, headers);
    const second = await convert(w.cookies.stateManager, leadId, {}, headers);
    expect(second.json).toEqual(first.json);
    expect(port.calls).toHaveLength(1);
  });
});
