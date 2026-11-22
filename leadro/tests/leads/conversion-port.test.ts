import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as convertRoute } from "@/app/api/v1/leads/[id]/convert/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { call } from "../org/org-helpers";
import { buildLeadWorld, forceStatus, intake, leadRow, type LeadWorld } from "./fixtures";

/**
 * Until the jobs module is wired into `job-conversion-port.ts`, conversion must fail loudly and change nothing: no
 * half-converted lead. (Not mocked here, so this file exercises the stub; delete it when the real port is wired.)
 */
let w: LeadWorld;
beforeAll(async () => {
  w = await buildLeadWorld("leads-port");
});
afterAll(disconnect);

describe("unwired job-conversion port", () => {
  it("answers 500 and leaves the lead QUALIFIED", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const jobType = await withTenant(w.tenantId, (tx) =>
      tx.jobType.create({ data: { tenantId: w.tenantId, code: "port-type", name: "Port type", category: "repair", defaultDurationMinutes: 60 } }),
    );
    const leadId = await intake(w, w.stateManager.actor, { customerId: customer.id, customerAddressId: addressId, jobTypeId: jobType.id });
    await forceStatus(w.tenantId, leadId, "QUALIFIED");
    const result = await call(convertRoute, "POST", `/api/v1/leads/${leadId}/convert`, { cookie: w.cookies.stateManager, params: { id: leadId }, body: {} });
    expect(result.status).toBe(500);
    expect((await leadRow(w.tenantId, leadId)).status).toBe("QUALIFIED");
  });
});
