import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listPlans, POST as createPlan } from "@/app/api/v1/development-plans/route";
import { GET as getPlan, PATCH as updatePlan } from "@/app/api/v1/development-plans/[id]/route";
import { POST as activate } from "@/app/api/v1/development-plans/[id]/activate/route";
import { POST as complete } from "@/app/api/v1/development-plans/[id]/complete/route";
import { POST as cancel } from "@/app/api/v1/development-plans/[id]/cancel/route";
import { POST as addGoal } from "@/app/api/v1/development-plans/[id]/goals/route";
import { PATCH as updateGoal } from "@/app/api/v1/development-plans/[id]/goals/[goalId]/route";
import { POST as addAction } from "@/app/api/v1/development-plans/[id]/actions/route";
import { PATCH as updateAction } from "@/app/api/v1/development-plans/[id]/actions/[actionId]/route";
import { POST as addReview } from "@/app/api/v1/development-plans/[id]/reviews/route";
import { POST as createCoachingRecord } from "@/app/api/v1/coaching/records/route";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { createMetricValue } from "../coaching/fixtures";
import { assignCourse, newCourse } from "../training/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let hr: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;

beforeAll(async () => {
  w = await buildWorld("devplans");
  hr = await sessionCookie(w.hr, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
});
afterAll(disconnect);

const tech = () => w.techA1.employeeId as string;
const planBody = (extra: Record<string, unknown> = {}) => ({
  employeeId: tech(),
  title: "Become lead installer",
  summary: "Focus on documentation.",
  periodStart: "2026-12-01",
  periodEnd: "2027-06-01",
  ...extra,
});
const create = (cookie: string, body: Record<string, unknown> = planBody()) => call(createPlan, "POST", "/x", { cookie, body });
const post = (handler: typeof activate, cookie: string, id: string, body: Record<string, unknown> = {}) => call(handler, "POST", "/x", { cookie, params: { id }, body });

describe("development plans", () => {
  it("a manager creates a DRAFT plan for an employee in scope; title and summary never reach the audit log", async () => {
    const result = await create(cityManagerA);
    expect(result.status).toBe(201);
    expect(result.json.data).toMatchObject({ status: "DRAFT", employeeId: tech(), ownerId: w.cityManagerA.userId, goals: [], actions: [], reviews: [] });
    const [event] = await auditEvents(w.tenantId, "development_plan.create", result.json.data.id);
    expect(JSON.stringify(event)).not.toContain("lead installer");
    expect(JSON.stringify(event.newValue)).toContain("titleSha256");
  });

  it("refuses a plan about oneself (403), an owner who cannot edit it (400), a bad period (400) and callers out of scope", async () => {
    expect((await create(cityManagerA, planBody({ employeeId: w.cityManagerA.employeeId }))).status).toBe(403);
    const badOwner = await create(cityManagerA, planBody({ ownerId: w.dispatcher.userId }));
    expect(badOwner.status).toBe(400);
    expect(badOwner.json.error.field).toBe("ownerId");
    expect((await create(cityManagerA, planBody({ periodEnd: "2026-11-01" }))).status).toBe(400);
    expect((await create(cityManagerB)).status).toBe(404);
    expect((await create(dispatcher)).status).toBe(403);
    expect((await create(techA1)).status).toBe(403);
  });

  it("goals, actions and reviews build the plan; links must be the same employee's", async () => {
    const plan = (await create(cityManagerA)).json.data;
    const metric = await createMetricValue(w.tenantId, tech(), w.hr.userId);
    const goal = await call(addGoal, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { title: "Complete forms on site", metricDefinitionId: metric.definitionId } });
    expect(goal.status).toBe(201);
    const goalId = goal.json.data.goals[0].id;
    const unpublished = await createMetricValue(w.tenantId, tech(), w.hr.userId, { published: false });
    expect((await call(addGoal, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { title: "x", metricDefinitionId: unpublished.definitionId } })).status).toBe(400);

    // TRAINING links an assignment of the plan's employee; another employee's assignment is "unknown".
    const course = await newCourse(hr);
    const own = (await assignCourse(hr, { employeeId: tech(), courseId: course.id })).json.data;
    const others = (await assignCourse(hr, { employeeId: w.techA1Other.employeeId, courseId: course.id })).json.data;
    const refused = await call(addAction, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { kind: "TRAINING", description: "Course", trainingAssignmentId: others.id } });
    expect(refused.status).toBe(400);
    expect(refused.json.error.field).toBe("trainingAssignmentId");
    expect((await call(addAction, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { kind: "OTHER", description: "x", trainingAssignmentId: own.id } })).status).toBe(400);
    const training = await call(addAction, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { kind: "TRAINING", description: "Course", trainingAssignmentId: own.id, goalId } });
    expect(training.status).toBe(201);

    const note = (await call(createCoachingRecord, "POST", "/x", { cookie: cityManagerA, body: { employeeId: tech(), body: "Talked about forms." } })).json.data;
    const coaching = await call(addAction, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { kind: "COACHING", description: "Monthly 1:1", coachingRecordId: note.id } });
    expect(coaching.status).toBe(201);
    expect(coaching.json.data.actions.map((action: { kind: string }) => action.kind)).toEqual(["TRAINING", "COACHING"]);

    const actionId = coaching.json.data.actions[1].id;
    const done = await call(updateAction, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id, actionId }, body: { status: "DONE" } });
    expect(done.json.data.actions[1]).toMatchObject({ status: "DONE" });
    expect(done.json.data.actions[1].completedAt).not.toBeNull();
    expect((await call(updateAction, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id, actionId }, body: { description: "y" } })).status).toBe(409);

    const achieved = await call(updateGoal, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id, goalId }, body: { status: "ACHIEVED" } });
    expect(achieved.json.data.goals[0].status).toBe("ACHIEVED");
    expect((await call(updateGoal, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id, goalId }, body: { status: "DROPPED" } })).status).toBe(409);
    expect((await call(updateGoal, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id, goalId }, body: { status: "OPEN" } })).json.data.goals[0]).toMatchObject({ status: "OPEN", achievedAt: null });

    await call(addReview, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { body: "Good start." } });
    const reviewed = await call(addReview, "POST", "/x", { cookie: hr, params: { id: plan.id }, body: { body: "Agreed." } });
    expect(reviewed.json.data.reviews.map((review: { body: string; planStatus: string }) => [review.body, review.planStatus])).toEqual([
      ["Good start.", "DRAFT"],
      ["Agreed.", "DRAFT"],
    ]);
    const [reviewEvent] = await auditEvents(w.tenantId, "development_plan.review", plan.id);
    expect(JSON.stringify(reviewEvent)).not.toContain("Agreed");
  });

  it("DRAFT -> ACTIVE (the employee is told, without a link) -> COMPLETED; a completed plan is final but takes reviews", async () => {
    const plan = (await create(cityManagerA)).json.data;
    expect((await post(complete, cityManagerA, plan.id)).status).toBe(409);
    const active = await post(activate, cityManagerA, plan.id);
    expect(active.status).toBe(200);
    expect(active.json.data.status).toBe("ACTIVE");
    const [notification] = await withTenant(w.tenantId, (tx) =>
      tx.notification.findMany({ where: { recipientId: w.techA1.userId, eventType: "development_plan.activated", eventId: `${plan.id}:activated` } }),
    );
    expect(notification).toMatchObject({ targetType: null, targetId: null });

    expect((await post(complete, cityManagerA, plan.id)).json.data.status).toBe("COMPLETED");
    expect((await call(updatePlan, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { title: "x" } })).status).toBe(409);
    expect((await call(addGoal, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { title: "x" } })).status).toBe(409);
    expect((await call(addReview, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { body: "Closing review." } })).json.data.reviews[0].planStatus).toBe("COMPLETED");
  });

  it("cancels with a reason; updates owner and period of an open plan", async () => {
    const plan = (await create(cityManagerA)).json.data;
    const updated = await call(updatePlan, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { ownerId: w.hr.userId, periodEnd: "2027-03-01" } });
    expect(updated.json.data).toMatchObject({ ownerId: w.hr.userId, periodEnd: "2027-03-01" });
    expect((await call(updatePlan, "PATCH", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { periodEnd: "2026-01-01" } })).status).toBe(400);
    expect((await post(cancel, cityManagerA, plan.id, {})).status).toBe(400);
    const cancelled = await post(cancel, cityManagerA, plan.id, { reason: "Moved to another team." });
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", cancelReason: "Moved to another team." });
    expect((await call(addReview, "POST", "/x", { cookie: cityManagerA, params: { id: plan.id }, body: { body: "x" } })).status).toBe(409);
    const [event] = await auditEvents(w.tenantId, "development_plan.cancel", plan.id);
    expect(JSON.stringify(event)).not.toContain("another team");
  });

  it("reading is scoped by the employee and needs development_plans.view", async () => {
    const plan = (await create(cityManagerA)).json.data;
    expect((await call(getPlan, "GET", "/x", { cookie: hr, params: { id: plan.id } })).status).toBe(200);
    expect((await call(getPlan, "GET", "/x", { cookie: cityManagerB, params: { id: plan.id } })).status).toBe(404);
    expect((await call(getPlan, "GET", "/x", { cookie: techA1, params: { id: plan.id } })).status).toBe(403);
    const listed = await call(listPlans, "GET", "/x", { cookie: cityManagerA, query: { employeeId: tech() } });
    expect(listed.json.data.map((row: { id: string }) => row.id)).toContain(plan.id);
    expect((await call(listPlans, "GET", "/x", { cookie: cityManagerB, query: { employeeId: tech() } })).json.data).toEqual([]);
    expect((await post(activate, cityManagerB, plan.id)).status).toBe(404);
  });
});
