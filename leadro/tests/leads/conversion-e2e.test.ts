import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as convertRoute } from "@/app/api/v1/leads/[id]/convert/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildLeadWorld, forceStatus, intake, leadRow, statusHistory, uniquePhone, type LeadWorld } from "./fixtures";

/** Conversion against the REAL jobs module (no mocks): lead CONVERTED and job created in one transaction. */
let w: LeadWorld;
let jobTypeId: string;

async function ready(fields: Record<string, unknown> = {}) {
  const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
  const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
  const leadId = await intake(w, w.stateManager.actor, { customerId: customer.id, customerAddressId: addressId, jobTypeId, requestedWork: "Fix sink", ...fields });
  await forceStatus(w.tenantId, leadId, "QUALIFIED");
  return { leadId, customer, addressId };
}
const convert = (cookie: string, leadId: string, body: Record<string, unknown> = {}) =>
  call(convertRoute, "POST", `/api/v1/leads/${leadId}/convert`, { cookie, params: { id: leadId }, body });
const jobsOf = (leadId: string) => withTenant(w.tenantId, (tx) => tx.job.findMany({ where: { tenantId: w.tenantId, leadId } }));

beforeAll(async () => {
  w = await buildLeadWorld("leads-e2e");
  jobTypeId = (await withTenant(w.tenantId, (tx) => tx.jobType.create({ data: { tenantId: w.tenantId, code: "e2e-type", name: "E2E type", category: "repair", defaultDurationMinutes: 60 } }))).id;
});
afterAll(disconnect);

describe("lead conversion with the real jobs module", () => {
  it("creates the job and converts the lead in one transaction, then replays with created:false", async () => {
    const { leadId, customer, addressId } = await ready();
    const first = await convert(w.cookies.stateManager, leadId);
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ status: "CONVERTED", created: true, replayed: false });
    const jobs = await jobsOf(leadId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: first.json.data.job.id, customerId: customer.id, serviceAddressId: addressId, origin: "LEAD_CONVERSION", leadId });
    expect((await leadRow(w.tenantId, leadId)).status).toBe("CONVERTED");
    expect((await statusHistory(w.tenantId, leadId)).pop()?.toStatus).toBe("CONVERTED");

    const second = await convert(w.cookies.stateManager, leadId);
    expect(second.status).toBe(200);
    expect(second.json.data).toMatchObject({ created: false, replayed: true, job: first.json.data.job });
    expect(await jobsOf(leadId)).toHaveLength(1);
  });

  it("rolls the lead back when the jobs module refuses (archived job type)", async () => {
    const { leadId } = await ready();
    const inactive = await withTenant(w.tenantId, (tx) => tx.jobType.create({ data: { tenantId: w.tenantId, code: `off-${Date.now()}`, name: "Off", category: "repair", defaultDurationMinutes: 30, active: false } }));
    const result = await convert(w.cookies.stateManager, leadId, { jobTypeId: inactive.id });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(await leadRow(w.tenantId, leadId)).toMatchObject({ status: "QUALIFIED", jobTypeId });
    expect(await jobsOf(leadId)).toHaveLength(0);
  });

  it("serialises concurrent conversions: one job, both answers 200, exactly one created", async () => {
    const { leadId } = await ready();
    const results = await Promise.all([convert(w.cookies.stateManager, leadId), convert(w.cookies.stateManager, leadId), convert(w.cookies.cityManagerA, leadId)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.json.data.created).length).toBe(1);
    expect(new Set(results.map((r) => r.json.data.job.id)).size).toBe(1);
    expect(await jobsOf(leadId)).toHaveLength(1);
  });

  it("needs leads.edit to change what the lead points at, and to confirm the duplicate flag", async () => {
    const phone = uniquePhone();
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA, phoneE164: phone });
    const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const leadId = await intake(w, w.stateManager.actor, { contactPhone: phone, jobTypeId });
    await forceStatus(w.tenantId, leadId, "QUALIFIED");
    const flagStatus = () => withTenant(w.tenantId, (tx) => tx.duplicateFlag.findFirst({ where: { tenantId: w.tenantId, leadId, kind: "LEAD_CUSTOMER" } }));
    expect((await flagStatus())?.status).toBe("OPEN");

    // A Dispatcher (jobs.create, no leads.edit) may convert a complete lead but not link a customer through it.
    const denied = await convert(w.cookies.dispatcher, leadId, { customerId: customer.id, serviceAddressId: addressId });
    expect(denied.status).toBe(403);
    expect((await leadRow(w.tenantId, leadId)).customerId).toBeNull();
    expect((await flagStatus())?.status).toBe("OPEN");
    expect(await jobsOf(leadId)).toHaveLength(0);

    const allowed = await convert(w.cookies.stateManager, leadId, { customerId: customer.id, serviceAddressId: addressId });
    expect(allowed.status).toBe(200);
    expect((await flagStatus())?.status).toBe("CONFIRMED_DUPLICATE");
    expect((await auditEvents(w.tenantId, "lead.convert", leadId)).length).toBe(1);
  });

  it("lets a Dispatcher convert a complete lead without touching it", async () => {
    const { leadId } = await ready();
    expect((await convert(w.cookies.dispatcher, leadId)).status).toBe(200);
  });
});
