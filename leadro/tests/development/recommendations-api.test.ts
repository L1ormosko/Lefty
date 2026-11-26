import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRecommendations } from "@/app/api/v1/training/recommendations/route";
import { GET as getRecommendation } from "@/app/api/v1/training/recommendations/[id]/route";
import { POST as accept } from "@/app/api/v1/training/recommendations/[id]/accept/route";
import { POST as dismiss } from "@/app/api/v1/training/recommendations/[id]/dismiss/route";
import { POST as generate } from "@/app/api/v1/training/recommendations/generate/route";
import { GET as getThresholds, PUT as putThresholds } from "@/app/api/v1/training/recommendations/thresholds/route";
import { POST as createPlan } from "@/app/api/v1/development-plans/route";
import { withTenant } from "@/server/db";
import { generateTrainingRecommendationsForTenant } from "@/server/development";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { createMetricValue } from "../coaching/fixtures";
import { newCourse, newTrainingCertification, tenantToday, unique } from "../training/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let hr: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;

beforeAll(async () => {
  w = await buildWorld("recommend");
  hr = await sessionCookie(w.hr, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
});
afterAll(disconnect);

interface Recommendation {
  id: string;
  employeeId: string;
  courseId: string;
  status: string;
  reasons: Array<Record<string, unknown>>;
  generatedById: string | null;
  dismissReason: string | null;
  dismissedBySystem: boolean;
  trainingAssignmentId: string | null;
}

const tech = () => w.techA1.employeeId as string;
const runFor = async (cookie: string, employeeId?: string) => call(generate, "POST", "/x", { cookie, body: employeeId ? { employeeId } : {} });
const recommendationsOf = (employeeId: string, courseId: string) =>
  withTenant(w.tenantId, (tx) => tx.trainingRecommendation.findMany({ where: { tenantId: w.tenantId, employeeId, courseId }, orderBy: { createdAt: "asc" } }));

/** A TRAINING certification, an active course granting it, and (optionally) a VERIFIED qualification expiring on `expiresOn`. */
async function trainingCertificationWithCourse(options: { holder?: string; expiresOn?: string } = {}) {
  const certification = await newTrainingCertification(w.tenantId);
  const course = await newCourse(hr, { certificationId: certification.id });
  if (options.holder) {
    await withTenant(w.tenantId, (tx) =>
      tx.employeeQualification.create({
        data: {
          tenantId: w.tenantId,
          employeeId: options.holder as string,
          kind: "TRAINING",
          certificationId: certification.id,
          status: "VERIFIED",
          verifiedById: w.hr.userId,
          verifiedAt: new Date(),
          issuedAt: new Date("2024-01-01"),
          expiresAt: options.expiresOn ? new Date(`${options.expiresOn}T00:00:00.000Z`) : null,
        },
      }),
    );
  }
  return { certification, course };
}

describe("rules", () => {
  it("expired and expiring TRAINING certifications are recommended with every reason; a re-run creates nothing new", async () => {
    const expired = await trainingCertificationWithCourse({ holder: tech(), expiresOn: await tenantToday(w.tenantId, -3) });
    const expiringOn = await tenantToday(w.tenantId, 10);
    const expiring = await trainingCertificationWithCourse({ holder: tech(), expiresOn: expiringOn });
    const later = await trainingCertificationWithCourse({ holder: tech(), expiresOn: await tenantToday(w.tenantId, 90) });

    const run = await runFor(cityManagerA, tech());
    expect(run.status).toBe(200);
    expect(run.json.data.evaluatedEmployees).toBe(1);
    const created = run.json.data.created as Recommendation[];
    const byCourse = new Map(created.map((row) => [row.courseId, row]));
    expect(byCourse.get(expired.course.id)?.reasons).toEqual([
      { code: "CERTIFICATION_EXPIRED", certificationId: expired.certification.id, expiresOn: await tenantToday(w.tenantId, -3) },
    ]);
    expect(byCourse.get(expiring.course.id)).toMatchObject({
      status: "OPEN",
      generatedById: w.cityManagerA.userId,
      reasons: [{ code: "CERTIFICATION_EXPIRING", certificationId: expiring.certification.id, expiresOn: expiringOn, daysRemaining: 10 }],
    });
    expect(byCourse.has(later.course.id)).toBe(false);
    expect((await auditEvents(w.tenantId, "training_recommendation.create", byCourse.get(expiring.course.id)?.id)).length).toBe(1);

    const again = await runFor(cityManagerA, tech());
    expect((again.json.data.created as Recommendation[]).filter((row) => [expired.course.id, expiring.course.id].includes(row.courseId))).toEqual([]);
    expect(await recommendationsOf(tech(), expiring.course.id)).toHaveLength(1);
  });

  it("a job type is a training need only when its TRAINING certification is the one thing the employee lacks", async () => {
    const { certification, course } = await trainingCertificationWithCourse();
    const category = unique("install");
    await withTenant(w.tenantId, async (tx) => {
      const jobType = await tx.jobType.create({ data: { tenantId: w.tenantId, code: unique("jt"), name: "Panel install", category, defaultDurationMinutes: 60 } });
      await tx.jobTypeCertification.create({ data: { tenantId: w.tenantId, jobTypeId: jobType.id, certificationId: certification.id } });
      // techA1 may do this category; techA1Other may not (so training alone would not make them eligible).
      await tx.employeeJobPermission.create({ data: { tenantId: w.tenantId, employeeId: tech(), category } });
    });
    const run = await runFor(hr);
    const created = run.json.data.created as Recommendation[];
    const mine = created.find((row) => row.employeeId === tech() && row.courseId === course.id);
    expect(mine?.reasons).toEqual([{ code: "JOB_TYPE_TRAINING_MISSING", jobTypeId: expect.any(String), certificationId: certification.id }]);
    expect(created.some((row) => row.employeeId === w.techA1Other.employeeId && row.courseId === course.id)).toBe(false);
  });

  it("the metric rule is off until HR sets a threshold; then a current value with enough data below it is a reason", async () => {
    expect((await call(getThresholds, "GET", "/x", { cookie: cityManagerA })).json.data).toEqual({ enabled: false, thresholds: [] });
    const value = await createMetricValue(w.tenantId, tech(), w.hr.userId); // 1 of 2, enough data
    const definition = await withTenant(w.tenantId, (tx) => tx.performanceMetricDefinition.findUniqueOrThrow({ where: { id: value.definitionId } }));
    const course = await newCourse(hr);
    const body = { thresholds: [{ metricKey: definition.key, belowMilli: 600, courseId: course.id }] };
    expect((await call(putThresholds, "PUT", "/x", { cookie: cityManagerA, body })).status).toBe(403);
    expect((await call(putThresholds, "PUT", "/x", { cookie: hr, body: { thresholds: [{ ...body.thresholds[0], courseId: "nope" }] } })).status).toBe(400);
    const saved = await call(putThresholds, "PUT", "/x", { cookie: hr, body });
    expect(saved.json.data).toEqual({ enabled: true, ...body });

    const run = await runFor(cityManagerA, tech());
    const created = (run.json.data.created as Recommendation[]).find((row) => row.courseId === course.id);
    expect(created?.reasons).toEqual([
      {
        code: "METRIC_BELOW_THRESHOLD",
        metricKey: definition.key,
        definitionId: definition.id,
        metricValueId: value.id,
        periodStart: "2026-03-01",
        periodEnd: "2026-04-01",
        jobTypeId: null,
        jobCategory: null,
        numerator: 1,
        denominator: 2,
        sampleSize: 2,
        belowMilli: 600,
      },
    ]);

    // A newer period without enough data is now the current value: "not enough data" counts against nobody, so the
    // open recommendation is dismissed by the system.
    await withTenant(w.tenantId, (tx) =>
      tx.performanceMetricValue.create({
        data: { tenantId: w.tenantId, definitionId: definition.id, employeeId: tech(), periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-05-01"), numerator: 0, denominator: 0, sampleSize: 0, enoughData: false, systemActor: "system:performance" },
      }),
    );
    const next = await runFor(cityManagerA, tech());
    expect((next.json.data.dismissed as Recommendation[]).find((row) => row.id === created?.id)).toMatchObject({ status: "DISMISSED", dismissReason: "NO_LONGER_APPLIES", dismissedBySystem: true });

    expect((await call(putThresholds, "PUT", "/x", { cookie: hr, body: { thresholds: [] } })).json.data).toEqual({ enabled: false, thresholds: [] });
  });
});

describe("decisions", () => {
  async function openRecommendation(): Promise<Recommendation> {
    const { course } = await trainingCertificationWithCourse({ holder: tech(), expiresOn: await tenantToday(w.tenantId, -1) });
    const created = (await runFor(cityManagerA, tech())).json.data.created as Recommendation[];
    const found = created.find((row) => row.courseId === course.id);
    expect(found).toBeDefined();
    return found as Recommendation;
  }

  it("accepting creates the assignment (source RECOMMENDATION) and, with a plan, a TRAINING action; the employee is told", async () => {
    const recommendation = await openRecommendation();
    const plan = (
      await call(createPlan, "POST", "/x", { cookie: cityManagerA, body: { employeeId: tech(), title: "Safety", periodStart: "2026-12-01", periodEnd: "2027-03-01" } })
    ).json.data;
    const accepted = await call(accept, "POST", "/x", { cookie: cityManagerA, params: { id: recommendation.id }, body: { planId: plan.id } });
    expect(accepted.status).toBe(200);
    expect(accepted.json.data).toMatchObject({ status: "ACCEPTED", trainingAssignmentId: expect.any(String) });
    const assignment = await withTenant(w.tenantId, (tx) => tx.trainingAssignment.findUniqueOrThrow({ where: { id: accepted.json.data.trainingAssignmentId } }));
    expect(assignment).toMatchObject({ source: "RECOMMENDATION", recommendationId: recommendation.id, courseId: recommendation.courseId, status: "ASSIGNED" });
    const actions = await withTenant(w.tenantId, (tx) => tx.developmentAction.findMany({ where: { planId: plan.id } }));
    expect(actions).toMatchObject([{ kind: "TRAINING", trainingAssignmentId: assignment.id }]);
    const notified = await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { recipientId: w.techA1.userId, eventType: "training.assigned", targetId: assignment.id } }));
    expect(notified).toBe(1);
    expect((await call(accept, "POST", "/x", { cookie: cityManagerA, params: { id: recommendation.id }, body: {} })).status).toBe(409);

    // The open assignment means no new recommendation of that course on the next run.
    await runFor(cityManagerA, tech());
    expect((await recommendationsOf(tech(), recommendation.courseId)).map((row) => row.status)).toEqual(["ACCEPTED"]);
  });

  it("an open assignment of the course already existing is a 409 and changes nothing", async () => {
    const recommendation = await openRecommendation();
    await withTenant(w.tenantId, (tx) =>
      tx.trainingAssignment.create({ data: { tenantId: w.tenantId, employeeId: tech(), courseId: recommendation.courseId, assignedById: w.hr.userId } }),
    );
    expect((await call(accept, "POST", "/x", { cookie: cityManagerA, params: { id: recommendation.id }, body: {} })).status).toBe(409);
    expect((await recommendationsOf(tech(), recommendation.courseId))[0].status).toBe("OPEN");
    // The next run dismisses it: the course is assigned already.
    const next = await runFor(cityManagerA, tech());
    expect((next.json.data.dismissed as Recommendation[]).find((row) => row.id === recommendation.id)?.dismissReason).toBe("ALREADY_ASSIGNED");
  });

  it("dismissing needs a reason; the same finding is not raised again", async () => {
    const recommendation = await openRecommendation();
    expect((await call(dismiss, "POST", "/x", { cookie: cityManagerA, params: { id: recommendation.id }, body: {} })).status).toBe(400);
    const dismissed = await call(dismiss, "POST", "/x", { cookie: cityManagerA, params: { id: recommendation.id }, body: { reason: "Moving to dispatch next month." } });
    expect(dismissed.json.data).toMatchObject({ status: "DISMISSED", dismissReason: "Moving to dispatch next month.", dismissedBySystem: false });
    const [event] = await auditEvents(w.tenantId, "training_recommendation.dismiss", recommendation.id);
    expect(JSON.stringify(event)).not.toContain("dispatch next month");
    await runFor(cityManagerA, tech());
    expect(await recommendationsOf(tech(), recommendation.courseId)).toHaveLength(1);
  });

  it("is scoped by the employee: other managers get 404, roles without training.assign 403", async () => {
    const recommendation = await openRecommendation();
    expect((await call(getRecommendation, "GET", "/x", { cookie: cityManagerB, params: { id: recommendation.id } })).status).toBe(404);
    expect((await call(accept, "POST", "/x", { cookie: cityManagerB, params: { id: recommendation.id }, body: {} })).status).toBe(404);
    expect((await call(getRecommendation, "GET", "/x", { cookie: hr, params: { id: recommendation.id } })).json.data.id).toBe(recommendation.id);
    expect((await call(listRecommendations, "GET", "/x", { cookie: cityManagerB, query: { employeeId: tech() } })).json.data).toEqual([]);
    expect((await call(listRecommendations, "GET", "/x", { cookie: dispatcher })).status).toBe(403);
    expect((await runFor(techA1)).status).toBe(403);
    expect((await runFor(cityManagerB, tech())).status).toBe(404);
  });

  it("the system run for a tenant has no actor", async () => {
    const { course } = await trainingCertificationWithCourse({ holder: w.techB.employeeId as string, expiresOn: await tenantToday(w.tenantId, -2) });
    const result = await generateTrainingRecommendationsForTenant(w.tenantId);
    const created = result.created.find((row) => row.courseId === course.id);
    expect(created).toMatchObject({ employeeId: w.techB.employeeId, generatedById: null });
    const [event] = await auditEvents(w.tenantId, "training_recommendation.create", created?.id);
    expect(event).toMatchObject({ actorUserId: null, actorType: "SYSTEM", sourceApp: "SYSTEM" });
  });
});
