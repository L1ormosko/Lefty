import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as archiveRoute } from "@/app/api/v1/leads/[id]/archive/route";
import { POST as restoreRoute } from "@/app/api/v1/leads/[id]/restore/route";
import { GET as listSourcesRoute, POST as createSourceRoute } from "@/app/api/v1/leads/sources/route";
import { PATCH as patchSourceRoute } from "@/app/api/v1/leads/sources/[sourceId]/route";
import { GET as listLeadsRoute } from "@/app/api/v1/leads/route";
import { assignedEmployeeIdsByCustomer, leadAssignedToWhere } from "@/server/customers";
import { withTenant } from "@/server/db";
import { assignLead, assignLeadSchema, leadRowAttributes } from "@/server/leads";
import { disconnect } from "../authz/fixtures";
import { makeCustomer } from "../customers/fixtures";
import { call, contextFor } from "../org/org-helpers";
import { activeAssignments, buildLeadWorld, intake, leadRow, type LeadWorld } from "./fixtures";

let w: LeadWorld;
beforeAll(async () => {
  w = await buildLeadWorld("leads-sources");
});
afterAll(disconnect);

describe("lead sources", () => {
  it("lets anyone who may view leads list them, and only a tenant-wide manager change them", async () => {
    const list = await call(listSourcesRoute, "GET", "/api/v1/leads/sources", { cookie: w.cookies.cityManagerA });
    expect(list.status).toBe(200);
    expect(list.json.data.map((row: { code: string }) => row.code)).toContain(w.sourceCode);

    const body = { code: "phone-line", name: "Phone line", type: "PHONE" };
    expect((await call(createSourceRoute, "POST", "/api/v1/leads/sources", { cookie: w.cookies.leadOps, body })).status).toBe(403); // unit-scoped manage
    const created = await call(createSourceRoute, "POST", "/api/v1/leads/sources", { cookie: w.cookies.ceo, body });
    expect(created.status).toBe(201);
    expect((await call(createSourceRoute, "POST", "/api/v1/leads/sources", { cookie: w.cookies.ceo, body })).status).toBe(409);
    expect((await call(createSourceRoute, "POST", "/api/v1/leads/sources", { cookie: w.cookies.ceo, body: { ...body, code: "Bad Code!" } })).status).toBe(400);
    expect((await call(createSourceRoute, "POST", "/api/v1/leads/sources", { cookie: w.cookies.techA1, body })).status).toBe(403);
  });

  it("switches a source off: new leads from it are refused, existing leads keep it", async () => {
    const created = await call(createSourceRoute, "POST", "/api/v1/leads/sources", {
      cookie: w.cookies.ceo,
      body: { code: "retired", name: "Retired", type: "IMPORT" },
    });
    const sourceId = created.json.data.id as string;
    const leadId = await intake(w, w.stateManager.actor, { sourceId });
    const off = await call(patchSourceRoute, "PATCH", `/api/v1/leads/sources/${sourceId}`, { cookie: w.cookies.ceo, params: { sourceId }, body: { active: false } });
    expect(off.json.data.active).toBe(false);
    await expect(intake(w, w.stateManager.actor, { sourceId })).rejects.toMatchObject({ field: "sourceId" });
    expect((await leadRow(w.tenantId, leadId)).sourceId).toBe(sourceId);
  });
});

describe("archiving leads", () => {
  it("archives (ending the owner's assignment), hides the lead from lists, and restores it", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assignLead(w.stateManager.actor, contextFor(w.stateManager.actor), leadId, assignLeadSchema.parse({ employeeId: w.techA1.employeeId }));
    const archived = await call(archiveRoute, "POST", `/api/v1/leads/${leadId}/archive`, { cookie: w.cookies.ceo, params: { id: leadId }, body: { reason: "Test data" } });
    expect(archived.status).toBe(200);
    expect(archived.json.data.archivedAt).toBeTruthy();
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);

    const visible = await call(listLeadsRoute, "GET", "/api/v1/leads", { cookie: w.cookies.stateManager, query: { limit: "200" } });
    expect(visible.json.data.map((row: { id: string }) => row.id)).not.toContain(leadId);
    const only = await call(listLeadsRoute, "GET", "/api/v1/leads", { cookie: w.cookies.stateManager, query: { archived: "only", limit: "200" } });
    expect(only.json.data.map((row: { id: string }) => row.id)).toContain(leadId);

    expect((await call(archiveRoute, "POST", `/api/v1/leads/${leadId}/archive`, { cookie: w.cookies.ceo, params: { id: leadId }, body: {} })).status).toBe(409);
    const restored = await call(restoreRoute, "POST", `/api/v1/leads/${leadId}/restore`, { cookie: w.cookies.ceo, params: { id: leadId }, body: {} });
    expect(restored.status).toBe(200);
    expect(restored.json.data.archivedAt).toBeNull();
  });

  it("needs leads.archive: Lead Operations (no archive in the default matrix) is refused", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const result = await call(archiveRoute, "POST", `/api/v1/leads/${leadId}/archive`, { cookie: w.cookies.leadOps, params: { id: leadId }, body: {} });
    expect(result.status).toBe(403);
  });
});

describe("ASSIGNED-scope derivation shared with customers", () => {
  it("agrees between the list fragment, the per-lead reference and the customer's assigned employees", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const leadId = await intake(w, w.stateManager.actor, { customerId: customer.id });
    const employeeId = w.techA1.employeeId as string;
    await assignLead(w.stateManager.actor, contextFor(w.stateManager.actor), leadId, assignLeadSchema.parse({ employeeId }));

    const viaFragment = await withTenant(w.tenantId, (tx) => tx.lead.findMany({ where: { tenantId: w.tenantId, ...leadAssignedToWhere(employeeId) }, select: { id: true } }));
    expect(viaFragment.map((row) => row.id)).toContain(leadId);

    const viaRef = await withTenant(w.tenantId, async (tx) => {
      const row = await tx.lead.findFirstOrThrow({ where: { id: leadId }, select: { id: true, status: true, orgUnitId: true, archivedAt: true, orgUnit: { select: { legalEntityId: true } } } });
      return (await leadRowAttributes(tx, w.tenantId, [row])).get(leadId)?.assignedEmployeeIds;
    });
    expect(viaRef).toEqual([employeeId]);

    const viaCustomer = await withTenant(w.tenantId, (tx) => assignedEmployeeIdsByCustomer(tx, w.tenantId, [customer.id]));
    expect(viaCustomer.get(customer.id)).toEqual([employeeId]);
  });
});
