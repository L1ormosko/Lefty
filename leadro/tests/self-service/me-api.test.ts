import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as raiseChallenge } from "@/app/api/v1/data-challenges/route";
import { GET as listMyChallenges } from "@/app/api/v1/me/data-challenges/route";
import { GET as getMyChallenge } from "@/app/api/v1/me/data-challenges/[id]/route";
import { GET as listMyCoachingNotes } from "@/app/api/v1/me/coaching-notes/route";
import { GET as listMyContextNotes } from "@/app/api/v1/me/context-notes/route";
import { GET as listMyPlans } from "@/app/api/v1/me/development-plans/route";
import { GET as getMyPlan } from "@/app/api/v1/me/development-plans/[id]/route";
import { GET as listMyMetrics } from "@/app/api/v1/me/metrics/route";
import { GET as getMyMetric } from "@/app/api/v1/me/metrics/[id]/route";
import { GET as listMyQualifications } from "@/app/api/v1/me/qualifications/route";
import { GET as listMyAssignments } from "@/app/api/v1/me/training/assignments/route";
import { GET as listMyRecords } from "@/app/api/v1/me/training/records/route";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { createMetricValue, createQualificationRecord, createTrainingRecord } from "../coaching/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

/**
 * Self-service (`/api/v1/me/*`, spec 5.11): every path filters on the caller's employee record and needs no module
 * permission. A Dispatcher (no training / performance permission) sees their own data; nobody sees anyone else's.
 */

let w: World;
let techA1: string;
let techA1Other: string;
let dispatcher: string;
let hr: string;
let published: { id: string; definitionId: string };
let preview: { id: string };
let otherValue: { id: string };
const notes: Record<string, string> = {};
let activePlanId: string;
let draftPlanId: string;

const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id);
const get = (handler: Parameters<typeof call>[0], cookie: string, options: { params?: Record<string, string>; query?: Record<string, string> } = {}) =>
  call(handler, "GET", "/x", { cookie, ...options });

beforeAll(async () => {
  w = await buildWorld("me");
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  techA1Other = await sessionCookie(w.techA1Other, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  hr = await sessionCookie(w.hr, w.tenantId);
  const me = w.techA1.employeeId as string;

  published = await createMetricValue(w.tenantId, me, w.hr.userId);
  preview = await createMetricValue(w.tenantId, me, w.hr.userId, { published: false });
  otherValue = await createMetricValue(w.tenantId, w.techA1Other.employeeId as string, w.hr.userId);

  await withTenant(w.tenantId, async (tx) => {
    const tenantId = w.tenantId;
    // A recomputation of the published value: the newest snapshot is the current one.
    const recomputed = await tx.performanceMetricValue.create({
      data: {
        tenantId,
        definitionId: published.definitionId,
        employeeId: me,
        periodStart: new Date("2026-03-01"),
        periodEnd: new Date("2026-04-01"),
        numerator: 2,
        denominator: 2,
        sampleSize: 2,
        enoughData: true,
        evidenceIds: ["a1", "a2"],
        systemActor: "system:performance",
        computedAt: new Date(Date.now() + 1000),
      },
    });
    notes.recomputed = recomputed.id;
    const coaching = (body: string, shared: boolean, archived = false, employeeId = me) =>
      tx.coachingRecord.create({
        data: { tenantId, employeeId, authorId: w.cityManagerA.userId, body, sharedWithEmployee: shared, sharedAt: shared ? new Date() : null, archivedAt: archived ? new Date() : null },
      });
    notes.shared = (await coaching("Shared note", true)).id;
    notes.private = (await coaching("Private note", false)).id;
    notes.archived = (await coaching("Archived shared note", true, true)).id;
    notes.otherShared = (await coaching("Someone else's note", true, false, w.techA1Other.employeeId as string)).id;
    const context = (shared: boolean) =>
      tx.metricContextNote.create({
        data: { tenantId, employeeId: me, metricValueId: published.id, body: shared ? "Parts were late." : "Private context.", authorId: w.cityManagerA.userId, sharedWithEmployee: shared, sharedAt: shared ? new Date() : null },
      });
    notes.sharedContext = (await context(true)).id;
    notes.privateContext = (await context(false)).id;

    const plan = (title: string) =>
      tx.developmentPlan.create({
        data: { tenantId, employeeId: me, ownerId: w.cityManagerA.userId, title, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-07-01"), createdById: w.cityManagerA.userId },
      });
    draftPlanId = (await plan("Draft plan")).id;
    activePlanId = (await plan("Active plan")).id;
    await tx.developmentPlan.update({ where: { id: activePlanId }, data: { status: "ACTIVE", activatedAt: new Date() } });
    await tx.developmentAction.create({ data: { tenantId, planId: activePlanId, employeeId: me, kind: "COACHING", description: "Talk", coachingRecordId: notes.private } });
    await tx.developmentAction.create({ data: { tenantId, planId: activePlanId, employeeId: me, kind: "COACHING", description: "Talk again", coachingRecordId: notes.shared } });
    await tx.developmentPlanReview.create({ data: { tenantId, planId: activePlanId, reviewerId: w.cityManagerA.userId, planStatus: "ACTIVE", body: "Manager-only review text." } });
  });
});
afterAll(disconnect);

describe("GET /api/v1/me/metrics", () => {
  it("returns only the caller's current values of published versions; evidence on the detail", async () => {
    const list = await get(listMyMetrics, techA1);
    expect(list.status).toBe(200);
    expect(ids(list)).toEqual([notes.recomputed]);
    expect(list.json.data[0]).toMatchObject({ numerator: 2, denominator: 2, sampleSize: 2, enoughData: true, evidenceCount: 2, definitionStatus: "PUBLISHED" });
    expect(list.json.data[0].evidenceIds).toBeUndefined();
    expect(list.json.data[0].employee).toBeUndefined();
    const detail = await get(getMyMetric, techA1, { params: { id: notes.recomputed } });
    expect(detail.json.data).toMatchObject({ evidenceIds: ["a1", "a2"], evidenceTable: "TrainingAssignment" });
    expect((await get(getMyMetric, techA1, { params: { id: preview.id } })).status).toBe(404);
    expect((await get(getMyMetric, techA1, { params: { id: otherValue.id } })).status).toBe(404);
  });

  it("a user without an employee record sees nothing", async () => {
    expect((await get(listMyMetrics, hr)).json.data).toEqual([]);
    expect((await get(getMyMetric, hr, { params: { id: published.id } })).status).toBe(404);
  });

  it("needs a session", async () => {
    expect((await call(listMyMetrics, "GET", "/x")).status).toBe(401);
  });
});

describe("GET /api/v1/me/coaching-notes and /me/context-notes", () => {
  it("lists only shared, non-archived notes about the caller", async () => {
    expect(ids(await get(listMyCoachingNotes, techA1))).toEqual([notes.shared]);
    expect(ids(await get(listMyCoachingNotes, techA1Other))).toEqual([notes.otherShared]);
    expect(ids(await get(listMyContextNotes, techA1))).toEqual([notes.sharedContext]);
    expect(ids(await get(listMyContextNotes, techA1, { query: { metricValueId: "nope" } }))).toEqual([]);
    expect((await get(listMyCoachingNotes, techA1, { query: { authorId: "x" } })).status).toBe(400);
  });
});

describe("GET /api/v1/me/training/* and /me/qualifications", () => {
  it("shows the caller's own training and credentials, even without any training permission (Dispatcher)", async () => {
    const dispatcherEmployee = w.dispatcher.employeeId as string;
    const record = await createTrainingRecord(w.tenantId, dispatcherEmployee, w.hr.userId);
    const qualification = await createQualificationRecord(w.tenantId, dispatcherEmployee);
    const assignment = await withTenant(w.tenantId, async (tx) => {
      const course = await tx.trainingRecord.findUniqueOrThrow({ where: { id: record.id }, select: { courseId: true } });
      return tx.trainingAssignment.create({ data: { tenantId: w.tenantId, employeeId: dispatcherEmployee, courseId: course.courseId, assignedById: w.hr.userId, dueDate: new Date("2026-01-02") } });
    });
    const assignments = await get(listMyAssignments, dispatcher);
    expect(ids(assignments)).toEqual([assignment.id]);
    expect(assignments.json.data[0]).toMatchObject({ overdue: true, status: "ASSIGNED", course: { name: "Safety basics" } });
    const records = await get(listMyRecords, dispatcher);
    expect(ids(records)).toEqual([record.id]);
    expect(records.json.data[0]).toMatchObject({ status: "PENDING_VERIFICATION", course: { name: "Safety basics" } });
    const qualifications = await get(listMyQualifications, dispatcher);
    expect(ids(qualifications)).toEqual([qualification.id]);
    expect(qualifications.json.data[0]).toMatchObject({ kind: "SKILL", status: "PENDING_VERIFICATION", skill: { name: "Brazing" } });
    expect(ids(await get(listMyAssignments, techA1))).toEqual([]);
    expect(ids(await get(listMyQualifications, techA1, { query: { kind: "LICENSE" } }))).toEqual([]);
  });
});

describe("GET /api/v1/me/development-plans", () => {
  it("lists non-draft plans only; the detail hides review text, the reviewer and links to private notes", async () => {
    expect(ids(await get(listMyPlans, techA1))).toEqual([activePlanId]);
    expect((await get(getMyPlan, techA1, { params: { id: draftPlanId } })).status).toBe(404);
    expect((await get(getMyPlan, techA1Other, { params: { id: activePlanId } })).status).toBe(404);
    const plan = await get(getMyPlan, techA1, { params: { id: activePlanId } });
    expect(plan.status).toBe(200);
    expect(plan.json.data).toMatchObject({ title: "Active plan", status: "ACTIVE" });
    expect(plan.json.data.cancelReason).toBeUndefined();
    expect(plan.json.data.reviews).toEqual([{ id: expect.any(String), planStatus: "ACTIVE", reviewedAt: expect.any(String) }]);
    expect(JSON.stringify(plan.json.data)).not.toContain("Manager-only");
    expect(plan.json.data.actions.map((action: { coachingRecordId: string | null }) => action.coachingRecordId).sort()).toEqual([notes.shared, null].sort());
  });
});

describe("GET /api/v1/me/data-challenges", () => {
  it("lists and reads the caller's own challenges only", async () => {
    const raised = await call(raiseChallenge, "POST", "/x", { cookie: techA1, body: { targetType: "PERFORMANCE_METRIC_VALUE", targetId: notes.recomputed, statement: "Two of these were not mine." } });
    expect(raised.status).toBe(201);
    const id = raised.json.data.id as string;
    const list = await get(listMyChallenges, techA1);
    expect(ids(list)).toEqual([id]);
    expect(list.json.data[0]).toMatchObject({ status: "OPEN", targetId: notes.recomputed, statement: "Two of these were not mine." });
    expect(ids(await get(listMyChallenges, techA1, { query: { status: "UPHELD" } }))).toEqual([]);
    expect((await get(getMyChallenge, techA1, { params: { id } })).json.data.id).toBe(id);
    expect((await get(getMyChallenge, techA1Other, { params: { id } })).status).toBe(404);
    expect(ids(await get(listMyChallenges, techA1Other))).toEqual([]);
  });
});
