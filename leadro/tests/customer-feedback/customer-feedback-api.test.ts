import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listFeedback, POST as recordFeedback } from "@/app/api/v1/customer-feedback/route";
import { GET as getFeedback } from "@/app/api/v1/customer-feedback/[id]/route";
import { POST as voidFeedback } from "@/app/api/v1/customer-feedback/[id]/void/route";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { buildPerformanceWorld, makeVisit, type PerformanceWorld } from "../performance/fixtures";

let w: PerformanceWorld;
let relationsA: string;
let relationsB: string;
let coo: string;
let cityManagerA: string;
let techA1: string;
let jobId: string;

const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id);
const record = (cookie: string, body: Record<string, unknown>) => call(recordFeedback, "POST", "/x", { cookie, body });

beforeAll(async () => {
  w = await buildPerformanceWorld("feedback");
  const crA = await createPerson(w.tenantId, "relations-a", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, crA, w.roles.CUSTOMER_RELATIONS, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  const crB = await createPerson(w.tenantId, "relations-b", { orgUnitId: w.units.cityB, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, crB, w.roles.CUSTOMER_RELATIONS, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);
  const cooPerson = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, cooPerson, w.roles.COO, [{ type: "TENANT" }]);
  relationsA = await sessionCookie(crA, w.tenantId);
  relationsB = await sessionCookie(crB, w.tenantId);
  coo = await sessionCookie(cooPerson, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  jobId = await makeVisit(w, { employeeId: w.techA1.employeeId as string, completedAt: new Date("2026-03-10T15:00:00Z") });
});
afterAll(disconnect);

describe("customer feedback", () => {
  it("Customer Relations records feedback about an employee on the job; the customer and unit come from the job", async () => {
    const created = await record(relationsA, { jobId, employeeId: w.techA1.employeeId, rating: 4, comment: "Friendly and quick." });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({
      jobId,
      customerId: w.customerId,
      orgUnitId: w.units.cityA,
      employeeId: w.techA1.employeeId,
      rating: 4,
      channel: "MANUAL",
      recordedById: expect.any(String),
      voidedAt: null,
    });
    expect(created.json.data.tenantId).toBeUndefined();
    const [event] = await auditEvents(w.tenantId, "customer_feedback.record", created.json.data.id);
    expect(JSON.stringify(event.newValue)).not.toContain("Friendly");
    expect(event.newValue).toMatchObject({ rating: 4, commentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("a comment alone or a rating alone is enough; neither, a bad rating, a future time or extra fields are 400", async () => {
    expect((await record(relationsA, { jobId, comment: "Great company." })).json.data).toMatchObject({ employeeId: null, rating: null });
    expect((await record(relationsA, { jobId, rating: 5 })).status).toBe(201);
    expect((await record(relationsA, { jobId })).status).toBe(400);
    expect((await record(relationsA, { jobId, rating: 6 })).status).toBe(400);
    expect((await record(relationsA, { jobId, rating: 2.5 })).status).toBe(400);
    expect((await record(relationsA, { jobId, rating: 3, receivedAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
    expect((await record(relationsA, { jobId, rating: 3, channel: "SURVEY" })).status).toBe(400);
  });

  it("the named employee must have been assigned to the job", async () => {
    const result = await record(relationsA, { jobId, employeeId: w.techA1Other.employeeId, rating: 2 });
    expect(result.status).toBe(400);
    expect(result.json.error.field).toBe("employeeId");
  });

  it("refuses a job outside the scope or unknown (404) and callers without the permission (403)", async () => {
    expect((await record(relationsB, { jobId, rating: 3 })).status).toBe(404);
    expect((await record(relationsA, { jobId: "nope", rating: 3 })).status).toBe(404);
    expect((await record(techA1, { jobId, rating: 3 })).status).toBe(403);
    expect((await record(coo, { jobId, rating: 3 })).status).toBe(403);
  });

  it("lists and reads in scope: viewers (COO, City manager) read, other units see nothing", async () => {
    const created = await record(relationsA, { jobId, rating: 3 });
    const id = created.json.data.id as string;
    expect(ids(await call(listFeedback, "GET", "/x", { cookie: coo, query: { jobId } }))).toContain(id);
    expect(ids(await call(listFeedback, "GET", "/x", { cookie: cityManagerA, query: { jobId } }))).toContain(id);
    expect(ids(await call(listFeedback, "GET", "/x", { cookie: relationsB, query: { jobId } }))).toEqual([]);
    expect((await call(getFeedback, "GET", "/x", { cookie: cityManagerA, params: { id } })).status).toBe(200);
    expect((await call(getFeedback, "GET", "/x", { cookie: relationsB, params: { id } })).status).toBe(404);
    expect((await call(listFeedback, "GET", "/x", { cookie: techA1 })).status).toBe(403);
  });

  it("voids once with a reason; voided entries are hidden unless asked for; the text never changes", async () => {
    const created = await record(relationsA, { jobId, employeeId: w.techA1.employeeId, rating: 1, comment: "Wrong job." });
    const id = created.json.data.id as string;
    expect((await call(voidFeedback, "POST", "/x", { cookie: cityManagerA, params: { id }, body: { reason: "x" } })).status).toBe(403);
    expect((await call(voidFeedback, "POST", "/x", { cookie: relationsB, params: { id }, body: { reason: "x" } })).status).toBe(404);
    expect((await call(voidFeedback, "POST", "/x", { cookie: relationsA, params: { id }, body: {} })).status).toBe(400);
    const voided = await call(voidFeedback, "POST", "/x", { cookie: relationsA, params: { id }, body: { reason: "Recorded on the wrong job." } });
    expect(voided.status).toBe(200);
    expect(voided.json.data).toMatchObject({ voidReason: "Recorded on the wrong job.", voidedAt: expect.any(String), comment: "Wrong job." });
    expect((await call(voidFeedback, "POST", "/x", { cookie: relationsA, params: { id }, body: { reason: "again" } })).status).toBe(409);
    expect(ids(await call(listFeedback, "GET", "/x", { cookie: relationsA, query: { jobId } }))).not.toContain(id);
    expect(ids(await call(listFeedback, "GET", "/x", { cookie: relationsA, query: { jobId, includeVoided: "true" } }))).toContain(id);
    const [event] = await auditEvents(w.tenantId, "customer_feedback.void", id);
    expect(JSON.stringify(event.newValue)).not.toContain("wrong job");
    await expect(
      withTenant(w.tenantId, (tx) => tx.customerFeedback.update({ where: { id }, data: { comment: "edited" } })),
    ).rejects.toThrow();
  });
});
