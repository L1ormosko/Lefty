import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/materials/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/v1/materials/[id]/route";
import { POST as archiveRoute } from "@/app/api/v1/materials/[id]/archive/route";
import { GET as costsRoute, POST as proposeRoute } from "@/app/api/v1/materials/[id]/costs/route";
import { POST as withdrawRoute } from "@/app/api/v1/materials/[id]/costs/[versionId]/withdraw/route";
import { GET as jobCostRoute } from "@/app/api/v1/materials/job-costs/[jobId]/route";
import { POST as costJobRoute } from "@/app/api/v1/materials/job-costs/[jobId]/cost/route";
import { POST as costUsageRoute } from "@/app/api/v1/materials/usages/[usageId]/cost/route";
import { POST as decideRoute } from "@/app/api/v1/approvals/[id]/decide/route";
import { GET as approvalRoute } from "@/app/api/v1/approvals/[id]/route";
import { createPolicy, createPolicySchema } from "@/server/approvals";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { auditEvents, call, contextFor, sessionCookie } from "../org/org-helpers";

let w: JobsWorld;
let other: JobsWorld;
let coo: string;
let cityJobId: string;

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY).toISOString();
let codeCounter = 0;
const nextCode = () => `mat-${Date.now().toString(36)}-${(codeCounter += 1)}`;

const createMaterial = async (body: Record<string, unknown> = {}, cookie = w.cookie.ceo) => {
  const response = await call(createRoute, "POST", "/x", { cookie, body: { code: nextCode(), name: "PVC pipe", unit: "m", supplier: "Demo Supply", ...body } });
  if (response.status !== 201) throw new Error(`setup: create material ${response.status} ${JSON.stringify(response.json)}`);
  return response.json.data as { id: string; code: string };
};
const propose = (materialId: string, body: Record<string, unknown>, cookie = w.cookie.ceo) =>
  call(proposeRoute, "POST", "/x", { cookie, params: { id: materialId }, body: { currency: "USD", ...body } });
const decide = (cookie: string, id: string, decision: "APPROVE" | "REJECT", comment?: string) =>
  call(decideRoute, "POST", "/x", { cookie, params: { id }, body: comment ? { decision, comment } : { decision } });

/** A usage line as the Phase 3 field app records it (straight into the table: the gate is tested elsewhere). */
async function recordUsage(jobId: string, data: { materialRef?: string | null; quantity: string; unit: string; occurredAt: string; name?: string }) {
  return withTenant(w.tenantId, (tx) =>
    tx.jobMaterialUsage.create({
      data: { tenantId: w.tenantId, jobId, name: data.name ?? "Pipe", materialRef: data.materialRef ?? null, quantity: data.quantity, unit: data.unit, occurredAt: new Date(data.occurredAt) },
    }),
  );
}
const usageRow = (id: string) => withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.findFirstOrThrow({ where: { id } }));

beforeAll(async () => {
  w = await buildJobsWorld("materials");
  other = await buildJobsWorld("materials-other");
  const cooPerson = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, cooPerson, w.roles.COO, [{ type: "TENANT" }]);
  coo = await sessionCookie(cooPerson, w.tenantId);
  cityJobId = (await createJobViaApi(w)).id as string;
});
afterAll(disconnect);

describe("catalog (spec 11.4)", () => {
  it("lets the COO maintain the catalog, refuses Finance and technicians, and keeps codes unique", async () => {
    const created = await call(createRoute, "POST", "/x", { cookie: coo, body: { code: "copper-fitting", name: "Copper fitting", unit: "each" } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ code: "copper-fitting", unit: "each", active: true });
    expect(created.json.data).not.toHaveProperty("currentCost");
    expect((await call(createRoute, "POST", "/x", { cookie: coo, body: { code: "copper-fitting", name: "Again" } })).status).toBe(409);
    expect((await call(createRoute, "POST", "/x", { cookie: w.cookie.finance, body: { code: "x-1", name: "x" } })).status).toBe(403);
    expect((await call(createRoute, "POST", "/x", { cookie: w.cookie.techA1, body: { code: "x-2", name: "x" } })).status).toBe(403);
    expect((await call(createRoute, "POST", "/x", { cookie: coo, body: { code: "Bad Code", name: "x" } })).status).toBe(400);

    const patched = await call(patchRoute, "PATCH", "/x", { cookie: coo, params: { id: created.json.data.id }, body: { supplier: "Other Supply", unit: "pack" } });
    expect(patched.json.data).toMatchObject({ supplier: "Other Supply", unit: "pack" });
    expect(await auditEvents(w.tenantId, "material.update", created.json.data.id)).toHaveLength(1);
  });

  it("lists for technicians (no costs) and hides archived materials unless asked", async () => {
    const material = await createMaterial();
    const listed = await call(listRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "200" } });
    expect(listed.status).toBe(200);
    expect(listed.json.data.map((row: { id: string }) => row.id)).toContain(material.id);
    const archived = await call(archiveRoute, "POST", "/x", { cookie: coo, params: { id: material.id }, body: { reason: "Discontinued" } });
    expect(archived.json.data).toMatchObject({ active: false });
    expect((await call(archiveRoute, "POST", "/x", { cookie: coo, params: { id: material.id }, body: {} })).status).toBe(409);
    const active = await call(listRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "200" } });
    expect(active.json.data.map((row: { id: string }) => row.id)).not.toContain(material.id);
    const all = await call(listRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "200", includeArchived: "true" } });
    expect(all.json.data.map((row: { id: string }) => row.id)).toContain(material.id);
    expect((await propose(material.id, { unitCostMinor: 100, effectiveFrom: iso(0) })).status).toBe(409);
  });

  it("is tenant-isolated", async () => {
    const material = await createMaterial();
    const otherCookie = other.cookie.ceo;
    expect((await call(getRoute, "GET", "/x", { cookie: otherCookie, params: { id: material.id } })).status).toBe(404);
    expect((await call(costsRoute, "GET", "/x", { cookie: otherCookie, params: { id: material.id } })).status).toBe(404);
    expect((await propose(material.id, { unitCostMinor: 100, effectiveFrom: iso(0) }, otherCookie)).status).toBe(404);
  });
});

describe("cost versions without an approval policy", () => {
  it("approves the change directly, closes the previous version, and projects costs by field set", async () => {
    const material = await createMaterial();
    const first = await propose(material.id, { unitCostMinor: 425, effectiveFrom: iso(0), note: "Supplier list" });
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ approvalRequired: false, approvalRequestId: null, version: { versionNumber: 1, status: "APPROVED", unitCostMinor: "425" } });
    const second = await propose(material.id, { unitCostMinor: "500", effectiveFrom: iso(30) });
    expect(second.json.data.version).toMatchObject({ versionNumber: 2, status: "APPROVED" });

    const history = await call(costsRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: material.id } });
    expect(history.json.data.map((row: { versionNumber: number; effectiveTo: string | null }) => [row.versionNumber, row.effectiveTo])).toEqual([
      [2, null],
      [1, iso(30)],
    ]);

    const owner = await call(getRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: material.id } });
    expect(owner.json.data.currentCost).toMatchObject({ versionNumber: 2, unitCostMinor: "500", currency: "USD" });
    for (const cookie of [coo, w.cookie.techA1, w.cookie.cityManagerA]) {
      const plain = await call(getRoute, "GET", "/x", { cookie, params: { id: material.id } });
      expect(plain.status).toBe(200);
      expect(plain.json.data).not.toHaveProperty("currentCost");
      expect(plain.json.data).not.toHaveProperty("pendingCost");
      expect((await call(costsRoute, "GET", "/x", { cookie, params: { id: material.id } })).status).toBe(403);
    }
    // COO holds materials.create but not the cost set: proposing a cost is refused.
    expect((await propose(material.id, { unitCostMinor: 1, effectiveFrom: iso(60) }, coo)).status).toBe(403);
    // A new version must start after the current one; unit is locked once a cost exists.
    const early = await propose(material.id, { unitCostMinor: 1, effectiveFrom: iso(30) });
    expect(early.status).toBe(409);
    expect(early.json.error.details[0].code).toBe("material.cost_not_after_current");
    const unit = await call(patchRoute, "PATCH", "/x", { cookie: coo, params: { id: material.id }, body: { unit: "ft" } });
    expect(unit.status).toBe(409);
  });
});

describe("job material costing: snapshot of the version in effect at usage time", () => {
  it("costs with the version of the usage date, rounds half-even, and never rewrites a costed line", async () => {
    const material = await createMaterial({ unit: "m" });
    await propose(material.id, { unitCostMinor: 425, effectiveFrom: iso(0) });
    const job = (await createJobViaApi(w)).id as string;
    const early = await recordUsage(job, { materialRef: material.code.toUpperCase(), quantity: "1.5", unit: "M", occurredAt: iso(10) });

    const costed = await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.finance, params: { usageId: early.id }, body: {} });
    expect(costed.status).toBe(200);
    expect(costed.json.data).toMatchObject({ costed: true, materialId: material.id, unitCostMinor: "425", extendedCostMinor: "638", currency: "USD", quantity: 1.5 });
    const snapshot = await usageRow(early.id);

    // A later cost change (effective after the usage) leaves the costed line exactly as it was.
    await propose(material.id, { unitCostMinor: 999, effectiveFrom: iso(20) });
    const late = await recordUsage(job, { materialRef: material.code, quantity: "2", unit: "m", occurredAt: iso(25) });
    const run = await call(costJobRoute, "POST", "/x", { cookie: w.cookie.finance, params: { jobId: job }, body: {} });
    expect(run.status).toBe(200);
    expect(run.json.data.results).toEqual([{ usageId: late.id, status: "COSTED", line: expect.objectContaining({ unitCostMinor: "999", extendedCostMinor: "1998" }) }]);
    expect(await usageRow(early.id)).toEqual(snapshot);

    const total = await call(jobCostRoute, "GET", "/x", { cookie: w.cookie.finance, params: { jobId: job } });
    expect(total.json.data).toMatchObject({ lineCount: 2, uncostedLineCount: 0, totals: [{ currency: "USD", directMaterialCostMinor: "2636", costedLineCount: 2 }] });

    // Costing again is a no-op; the database refuses to change a snapshot or its quantity directly.
    expect((await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.finance, params: { usageId: early.id }, body: {} })).json.error.details[0].code).toBe("material.usage_already_costed");
    await expect(withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.update({ where: { id: early.id }, data: { unitCostMinor: 1n } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.update({ where: { id: early.id }, data: { quantity: "3" } }))).rejects.toThrow();
    expect(await auditEvents(w.tenantId, "job_material.costed", early.id)).toHaveLength(1);

    // A cost change starting before an already-costed usage is refused: it would strand that snapshot.
    const backdated = await propose(material.id, { unitCostMinor: 1, effectiveFrom: iso(22) });
    expect(backdated.status).toBe(409);
    expect(backdated.json.error.details[0].code).toBe("material.cost_before_costed_usage");
  });

  it("skips lines it cannot cost and says why", async () => {
    const material = await createMaterial({ unit: "each" });
    await propose(material.id, { unitCostMinor: 100, effectiveFrom: iso(100) });
    const job = (await createJobViaApi(w)).id as string;
    const unlinked = await recordUsage(job, { materialRef: null, quantity: "1", unit: "each", occurredAt: iso(110) });
    const wrongUnit = await recordUsage(job, { materialRef: material.code, quantity: "1", unit: "box", occurredAt: iso(110) });
    const tooEarly = await recordUsage(job, { materialRef: material.code, quantity: "1", unit: "each", occurredAt: iso(50) });
    const run = await call(costJobRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { jobId: job }, body: {} });
    const codeOf = (id: string) => run.json.data.results.find((row: { usageId: string }) => row.usageId === id)?.code;
    expect(codeOf(unlinked.id)).toBe("material.usage_not_linked");
    expect(codeOf(wrongUnit.id)).toBe("material.unit_mismatch");
    expect(codeOf(tooEarly.id)).toBe("material.no_effective_cost");
    expect(run.json.data.cost).toMatchObject({ uncostedLineCount: 3, totals: [] });

    // An unlinked line can be linked to a catalog material explicitly; not to another tenant's material.
    const otherMaterial = await call(createRoute, "POST", "/x", { cookie: other.cookie.ceo, body: { code: nextCode(), name: "Foreign", unit: "each" } });
    expect((await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { usageId: unlinked.id }, body: { materialId: otherMaterial.json.data.id } })).status).toBe(404);
    const linked = await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { usageId: unlinked.id }, body: { materialId: material.id } });
    expect(linked.json.data).toMatchObject({ materialId: material.id, extendedCostMinor: "100" });
  });

  it("scope: job out of scope is 404, no cost set is 403, another tenant's usage is 404", async () => {
    const usage = await recordUsage(cityJobId, { materialRef: null, quantity: "1", unit: "each", occurredAt: iso(1) });
    expect((await call(jobCostRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { jobId: cityJobId } })).status).toBe(404);
    expect((await call(jobCostRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { jobId: cityJobId } })).status).toBe(403);
    expect((await call(costJobRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { jobId: cityJobId }, body: {} })).status).toBe(403);
    expect((await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.cityManagerB, params: { usageId: usage.id }, body: {} })).status).toBe(404);
    expect((await call(costUsageRoute, "POST", "/x", { cookie: other.cookie.ceo, params: { usageId: usage.id }, body: {} })).status).toBe(404);
    expect((await call(jobCostRoute, "GET", "/x", { cookie: other.cookie.finance, params: { jobId: cityJobId } })).status).toBe(404);
    expect((await call(jobCostRoute, "GET", "/x", { cookie: w.cookie.finance, params: { jobId: cityJobId } })).status).toBe(200);
  });
});

describe("cost versions through the approval engine (MATERIAL_COST_CHANGE policy)", () => {
  beforeAll(async () => {
    await createPolicy(
      w.finance.actor,
      contextFor(w.finance.actor),
      createPolicySchema.parse({ code: "material_cost_change", subjectType: "MATERIAL_COST_CHANGE", name: "Material cost change", approverPermission: "materials.approve" }),
    );
  });

  it("waits for approval, refuses the proposer (separation of duties), and takes effect when another approver approves", async () => {
    const material = await createMaterial();
    const proposed = await propose(material.id, { unitCostMinor: 700, effectiveFrom: iso(0), note: "New supplier price" });
    expect(proposed.status).toBe(201);
    expect(proposed.json.data).toMatchObject({ approvalRequired: true, version: { status: "PENDING_APPROVAL" } });
    const requestId = proposed.json.data.approvalRequestId as string;
    const versionId = proposed.json.data.version.id as string;

    const pendingView = await call(getRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: material.id } });
    expect(pendingView.json.data).toMatchObject({ currentCost: null, pendingCost: { versionId, status: "PENDING_APPROVAL" } });
    expect((await propose(material.id, { unitCostMinor: 800, effectiveFrom: iso(5) })).status).toBe(409); // one pending at a time

    // The Owner holds materials.approve but proposed the change: 403, audited, still pending.
    expect((await decide(w.cookie.ceo, requestId, "APPROVE")).status).toBe(403);
    // The COO oversees approvals but sees no cost amount or details.
    const overseen = await call(approvalRoute, "GET", "/x", { cookie: coo, params: { id: requestId } });
    expect(overseen.json.data).toMatchObject({ moneyRedacted: true });
    expect(overseen.json.data).not.toHaveProperty("details");

    const approved = await decide(w.cookie.finance, requestId, "APPROVE");
    expect(approved.status).toBe(200);
    expect(approved.json.data.status).toBe("APPROVED");
    const history = await call(costsRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: material.id } });
    expect(history.json.data[0]).toMatchObject({ id: versionId, status: "APPROVED", approvalRequestId: requestId });
    expect(await auditEvents(w.tenantId, "material_cost_version.approved", versionId)).toHaveLength(1);
    // Once approved, the version's facts are frozen by the database.
    await expect(withTenant(w.tenantId, (tx) => tx.materialCostVersion.update({ where: { id: versionId }, data: { unitCostMinor: 1n } }))).rejects.toThrow();
  });

  it("a rejection leaves the cost unchanged; a withdrawal cancels the request", async () => {
    const material = await createMaterial();
    const first = await propose(material.id, { unitCostMinor: 100, effectiveFrom: iso(0) });
    await decide(w.cookie.finance, first.json.data.approvalRequestId, "APPROVE");

    const rejected = await propose(material.id, { unitCostMinor: 150, effectiveFrom: iso(10) });
    expect((await decide(w.cookie.finance, rejected.json.data.approvalRequestId, "REJECT", "Quote not attached")).json.data.status).toBe("REJECTED");
    const afterReject = await call(costsRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: material.id } });
    expect(afterReject.json.data.map((row: { status: string; effectiveTo: string | null }) => [row.status, row.effectiveTo])).toEqual([
      ["REJECTED", null],
      ["APPROVED", null],
    ]);

    const withdrawn = await propose(material.id, { unitCostMinor: 160, effectiveFrom: iso(10) });
    const versionId = withdrawn.json.data.version.id as string;
    expect((await call(withdrawRoute, "POST", "/x", { cookie: coo, params: { id: material.id, versionId }, body: { reason: "x" } })).status).toBe(403);
    const done = await call(withdrawRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { id: material.id, versionId }, body: { reason: "Wrong currency" } });
    expect(done.json.data).toMatchObject({ status: "CANCELLED" });
    const request = await call(approvalRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: withdrawn.json.data.approvalRequestId } });
    expect(request.json.data).toMatchObject({ status: "CANCELLED" });
    expect((await call(withdrawRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { id: material.id, versionId }, body: { reason: "again" } })).status).toBe(409);
  });

  it("refuses an approval whose date no longer fits (a usage after it was costed meanwhile); the decision rolls back", async () => {
    const material = await createMaterial({ unit: "each" });
    const v1 = await propose(material.id, { unitCostMinor: 200, effectiveFrom: iso(0) });
    await decide(w.cookie.finance, v1.json.data.approvalRequestId, "APPROVE");
    const pending = await propose(material.id, { unitCostMinor: 300, effectiveFrom: iso(40) });
    const job = (await createJobViaApi(w)).id as string;
    const usage = await recordUsage(job, { materialRef: material.code, quantity: "1", unit: "each", occurredAt: iso(45) });
    expect((await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.finance, params: { usageId: usage.id }, body: {} })).json.data.unitCostMinor).toBe("200");

    const refused = await decide(w.cookie.finance, pending.json.data.approvalRequestId, "APPROVE");
    expect(refused.status).toBe(409);
    const request = await call(approvalRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: pending.json.data.approvalRequestId } });
    expect(request.json.data).toMatchObject({ status: "PENDING", approvalCount: 0 });
    expect((await decide(w.cookie.finance, pending.json.data.approvalRequestId, "REJECT", "Date overlaps costed work")).json.data.status).toBe("REJECTED");
  });

  it("archiving a material cancels its pending cost change", async () => {
    const material = await createMaterial();
    const pending = await propose(material.id, { unitCostMinor: 100, effectiveFrom: iso(0) });
    await call(archiveRoute, "POST", "/x", { cookie: coo, params: { id: material.id }, body: { reason: "Discontinued" } });
    const request = await call(approvalRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: pending.json.data.approvalRequestId } });
    expect(request.json.data.status).toBe("CANCELLED");
    const history = await call(costsRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: material.id } });
    expect(history.json.data[0].status).toBe("CANCELLED");
  });

  it("P4-R5: an approver without the cost set decides but never sees the unit costs in the request", async () => {
    const person = await createPerson(w.tenantId, "cost-blind-approver", { withEmployee: false });
    const role = await makeRole(w.tenantId, "Cost-blind approver", [{ permission: "materials.view" }, { permission: "materials.approve" }, { permission: "approvals.view" }]);
    await grantTemplate(w.tenantId, person, role, [{ type: "TENANT" }]);
    const cookie = await sessionCookie(person, w.tenantId);
    const material = await createMaterial();
    const proposed = await propose(material.id, { unitCostMinor: 915, effectiveFrom: iso(0) });
    const requestId = proposed.json.data.approvalRequestId as string;

    const seen = await call(approvalRoute, "GET", "/x", { cookie, params: { id: requestId } });
    expect(seen.status).toBe(200);
    expect(seen.json.data).toMatchObject({ moneyRedacted: true, viewer: { canDecide: true } });
    expect(seen.json.data).not.toHaveProperty("details");
    // Finance holds the cost set and still sees them.
    const finance = await call(approvalRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: requestId } });
    expect(finance.json.data).toMatchObject({ moneyRedacted: false, details: { unitCostMinor: "915" } });
    expect((await decide(cookie, requestId, "APPROVE")).json.data).toMatchObject({ status: "APPROVED", moneyRedacted: true });
  });
});
