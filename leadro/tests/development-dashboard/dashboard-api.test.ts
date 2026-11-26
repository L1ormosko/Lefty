import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getDevelopment } from "@/app/api/v1/employees/[id]/development/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "../authz/fixtures";
import { createMetricValue } from "../coaching/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

/**
 * The manager development dashboard (`GET /api/v1/employees/{id}/development`, spec 10.4): positions among comparable
 * colleagues in the VIEWER's scope, history, evidence links, and coaching content only with the coaching field set.
 */

let w: World;
let cookies: Record<string, string>;
let subject: string;
let definitionId: string;
let marchValueId: string;
let privateNoteId: string;
let planId: string;
let lowestEmployeeId: string;

const march = { periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-04-01") };

async function insertValue(employeeId: string, numerator: number, period = march): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const row = await tx.performanceMetricValue.create({
      data: {
        tenantId: w.tenantId,
        definitionId,
        employeeId,
        ...period,
        numerator,
        denominator: 2,
        sampleSize: 2,
        enoughData: true,
        evidenceIds: ["e1", "e2"],
        systemActor: "system:performance",
        computedAt: new Date(Date.now() + 1000),
      },
    });
    return row.id;
  });
}

const dashboard = (cookie: string, id = subject) => call(getDevelopment, "GET", "/x", { cookie, params: { id } });

beforeAll(async () => {
  w = await buildWorld("devdash");
  subject = w.techA1.employeeId as string;
  // Two more technicians in Team A1, so City A has four comparable people.
  const extra = [];
  for (const label of ["tech-a1-third", "tech-a1-fourth"]) {
    const person = await createPerson(w.tenantId, label, { orgUnitId: w.units.teamA1, legalEntityId: w.legalEntityId });
    await grantTemplate(w.tenantId, person, w.roles.TECHNICIAN, [{ type: "OWN" }]);
    extra.push(person.employeeId as string);
  }
  const coo = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, coo, w.roles.COO, [{ type: "TENANT" }]);

  const first = await createMetricValue(w.tenantId, subject, w.hr.userId);
  definitionId = first.definitionId;
  await insertValue(subject, 0, { periodStart: new Date("2026-02-01"), periodEnd: new Date("2026-03-01") });
  marchValueId = await insertValue(subject, 2); // recomputation: the current March value
  await insertValue(w.techA1Other.employeeId as string, 1);
  await insertValue(extra[0] as string, 1);
  await insertValue(extra[1] as string, 0);
  lowestEmployeeId = extra[1] as string;
  await insertValue(w.techB.employeeId as string, 2); // City B: outside City A's scope
  await createMetricValue(w.tenantId, subject, w.hr.userId, { published: false }); // a preview: never on the dashboard

  await withTenant(w.tenantId, async (tx) => {
    const tenantId = w.tenantId;
    privateNoteId = (await tx.coachingRecord.create({ data: { tenantId, employeeId: subject, authorId: w.cityManagerA.userId, body: "Private coaching." } })).id;
    await tx.metricContextNote.create({ data: { tenantId, employeeId: subject, metricValueId: marchValueId, body: "Parts were late.", authorId: w.cityManagerA.userId } });
    planId = (
      await tx.developmentPlan.create({
        data: { tenantId, employeeId: subject, ownerId: w.cityManagerA.userId, title: "Arrivals", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-07-01") },
      })
    ).id;
    await tx.developmentPlanReview.create({ data: { tenantId, planId, reviewerId: w.cityManagerA.userId, planStatus: "DRAFT", body: "Kick-off review." } });
  });

  cookies = {
    cityManagerA: await sessionCookie(w.cityManagerA, w.tenantId),
    cityManagerB: await sessionCookie(w.cityManagerB, w.tenantId),
    hr: await sessionCookie(w.hr, w.tenantId),
    coo: await sessionCookie(coo, w.tenantId),
    dispatcher: await sessionCookie(w.dispatcher, w.tenantId),
    techA1: await sessionCookie(w.techA1, w.tenantId),
  };
});
afterAll(disconnect);

describe("GET /api/v1/employees/{id}/development", () => {
  it("shows each published series with its history, evidence links and the position among City A colleagues", async () => {
    const result = await dashboard(cookies.cityManagerA as string);
    expect(result.status).toBe(200);
    const data = result.json.data;
    expect(data.metrics).toHaveLength(1);
    const [metric] = data.metrics;
    expect(metric).toMatchObject({ definitionId, kind: "TRAINING_PROGRESS", dimension: "TRAINING_PROGRESS", definitionStatus: "PUBLISHED", jobTypeId: null });
    expect(metric.current).toMatchObject({ valueId: marchValueId, numerator: 2, denominator: 2, sampleSize: 2, evidenceCount: 2, evidenceUrl: `/api/v1/performance/values/${marchValueId}` });
    expect(metric.history.map((period: { periodStart: string; numerator: number }) => [period.periodStart, period.numerator])).toEqual([
      ["2026-02-01", 0],
      ["2026-03-01", 2],
    ]);
    expect(metric.position).toEqual({ status: "POSITIONED", peerCount: 4, betterCount: 0, sameCount: 0, worseCount: 3, quartile: 1, lowerIsBetter: false });
    expect(metric.assessment).toBe("STRENGTH");
    expect(data.strengths).toEqual([expect.objectContaining({ definitionId, valueId: marchValueId })]);
    expect(data.developmentOpportunities).toEqual([]);
  });

  it("compares within the viewer's scope: HR (tenant-wide) counts City B too", async () => {
    const data = (await dashboard(cookies.hr as string)).json.data;
    expect(data.metrics[0].position).toMatchObject({ peerCount: 5, betterCount: 0, sameCount: 1, quartile: 1 });
  });

  it("a colleague in the middle is typical; the lowest of the group is a development opportunity", async () => {
    const middle = (await dashboard(cookies.cityManagerA as string, w.techA1Other.employeeId as string)).json.data;
    expect(middle.metrics[0].position).toMatchObject({ quartile: 2, betterCount: 1, sameCount: 1 });
    expect(middle.metrics[0].assessment).toBe("TYPICAL");
    const lowest = (await dashboard(cookies.cityManagerA as string, lowestEmployeeId)).json.data;
    expect(lowest.metrics[0]).toMatchObject({ assessment: "DEVELOPMENT_OPPORTUNITY", position: { quartile: 4, betterCount: 3 } });
    expect(lowest.developmentOpportunities).toHaveLength(1);
  });

  it("returns coaching notes, context notes, plans and review history to the management chain", async () => {
    const data = (await dashboard(cookies.cityManagerA as string)).json.data;
    expect(data.coachingNotes.map((note: { id: string }) => note.id)).toEqual([privateNoteId]);
    expect(data.contextNotes).toHaveLength(1);
    expect(data.plans.map((plan: { id: string }) => plan.id)).toEqual([planId]);
    expect(data.reviewHistory).toEqual([expect.objectContaining({ planId, body: "Kick-off review.", planStatus: "DRAFT" })]);
    expect(data.recommendations).toEqual([]);
  });

  it("hides coaching content without the coaching field set (COO): sections are null, values stay", async () => {
    const result = await dashboard(cookies.coo as string);
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ coachingNotes: null, contextNotes: null, plans: null, reviewHistory: null });
    expect(result.json.data.metrics).toHaveLength(1);
    expect(JSON.stringify(result.json.data)).not.toContain("Private coaching");
  });

  it("an employee reading their own dashboard has no peers to compare with and no coaching content", async () => {
    const data = (await dashboard(cookies.techA1 as string)).json.data;
    expect(data.metrics[0].position).toMatchObject({ status: "NOT_ENOUGH_PEERS", peerCount: 1, quartile: null });
    expect(data.metrics[0].assessment).toBeNull();
    expect(data).toMatchObject({ coachingNotes: null, plans: null, contextNotes: null });
  });

  it("is a 404 outside the scope and a 403 without performance.view", async () => {
    expect((await dashboard(cookies.cityManagerB as string)).status).toBe(404);
    expect((await dashboard(cookies.dispatcher as string)).status).toBe(403);
    expect((await dashboard(cookies.techA1 as string, w.techA1Other.employeeId as string)).status).toBe(404);
  });

  it("never returns a combined score", async () => {
    const text = JSON.stringify((await dashboard(cookies.hr as string)).json.data);
    expect(text).not.toMatch(/"(score|totalScore|overall|average|rank)"/i);
  });
});
