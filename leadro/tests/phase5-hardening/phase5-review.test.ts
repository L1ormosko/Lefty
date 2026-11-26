import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApprovalRequest, decideApprovalSchema } from "@/server/approvals";
import {
  createCoachingRecord,
  createCoachingRecordSchema,
  createContextNote,
  createContextNoteSchema,
  getCoachingRecord,
  getContextNote,
  listCoachingRecords,
  listCoachingRecordsQuerySchema,
  listContextNotes,
  listContextNotesQuerySchema,
} from "@/server/coaching";
import { recordCustomerFeedback, recordFeedbackSchema, voidCustomerFeedback, voidFeedbackSchema } from "@/server/customer-feedback";
import { withTenant } from "@/server/db";
import {
  acceptRecommendation,
  acceptRecommendationSchema,
  activatePlan,
  addReview,
  cancelPlan,
  cancelPlanSchema,
  createPlan,
  createPlanSchema,
  createReviewSchema,
  dismissRecommendation,
  dismissRecommendationSchema,
  getPlan,
  listPlans,
  listPlansQuerySchema,
  updatePlan,
  updatePlanSchema,
} from "@/server/development";
import { getEmployeeDevelopment } from "@/server/development-dashboard";
import { computeMetricValues, computeValuesSchema, submitDefinition, submitDefinitionSchema, updateDefinition, updateDefinitionSchema } from "@/server/performance";
import { assignTraining, cancelAssignment, updateAssignment } from "@/server/training";
import { createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { contextFor } from "../org/org-helpers";
import { buildPerformanceWorld, makeDefinition, makeVisit, type PerformanceWorld } from "../performance/fixtures";

/**
 * Regression tests of the Phase 5 whole-phase review (docs/reviews/phase5-review.md). Each case reproduced the finding
 * against the real test database before the fix.
 */

let w: PerformanceWorld;
/** The City A manager is placed in City A, so their own record is inside their ORG_UNIT scope. */
let manager: string;
const ctx = (actor: PerformanceWorld["hr"]["actor"]) => contextFor(actor);

const noteBody = "Private: discuss the manager's missed escalations";

beforeAll(async () => {
  w = await buildPerformanceWorld("p5review");
  manager = w.cityManagerA.employeeId as string;
});
afterAll(disconnect);

describe("P5-R1: coaching content about oneself is never read through a management grant", () => {
  it("the City A manager does not see a private coaching note the State manager wrote about them", async () => {
    const note = await createCoachingRecord(w.stateManager.actor, ctx(w.stateManager.actor), createCoachingRecordSchema.parse({ employeeId: manager, body: noteBody }));
    // The author and HR still see it.
    expect((await getCoachingRecord(w.stateManager.actor, note.id)).id).toBe(note.id);
    expect((await getCoachingRecord(w.hr.actor, note.id)).id).toBe(note.id);
    // The subject does not (they read shared notes through /me/coaching-notes).
    await expect(getCoachingRecord(w.cityManagerA.actor, note.id)).rejects.toMatchObject({ httpStatus: 404 });
    const listed = await listCoachingRecords(w.cityManagerA.actor, listCoachingRecordsQuerySchema.parse({}));
    expect(listed.data.map((row) => row.id)).not.toContain(note.id);
    const filtered = await listCoachingRecords(w.cityManagerA.actor, listCoachingRecordsQuerySchema.parse({ employeeId: manager }));
    expect(filtered.data).toEqual([]);
  });

  it("the City A manager does not see a private context note about their own metrics", async () => {
    const note = await createContextNote(
      w.stateManager.actor,
      ctx(w.stateManager.actor),
      createContextNoteSchema.parse({ employeeId: manager, periodStart: "2026-03-01", periodEnd: "2026-04-01", body: noteBody }),
    );
    expect((await getContextNote(w.hr.actor, note.id)).id).toBe(note.id);
    await expect(getContextNote(w.cityManagerA.actor, note.id)).rejects.toMatchObject({ httpStatus: 404 });
    const listed = await listContextNotes(w.cityManagerA.actor, listContextNotesQuerySchema.parse({ employeeId: manager }));
    expect(listed.data).toEqual([]);
  });

  it("the City A manager does not read their own development plan (review text) through development_plans.view", async () => {
    const plan = await createPlan(
      w.stateManager.actor,
      ctx(w.stateManager.actor),
      createPlanSchema.parse({ employeeId: manager, title: "Escalation handling", periodStart: "2026-01-01", periodEnd: "2026-07-01" }),
    );
    await addReview(w.stateManager.actor, ctx(w.stateManager.actor), plan.id, createReviewSchema.parse({ body: noteBody }));
    expect((await getPlan(w.hr.actor, plan.id)).reviews).toHaveLength(1);
    await expect(getPlan(w.cityManagerA.actor, plan.id)).rejects.toMatchObject({ httpStatus: 404 });
    const listed = await listPlans(w.cityManagerA.actor, listPlansQuerySchema.parse({ employeeId: manager }));
    expect(listed.data).toEqual([]);
  });

  it("the manager's own development dashboard carries no coaching content about them", async () => {
    await createCoachingRecord(w.stateManager.actor, ctx(w.stateManager.actor), createCoachingRecordSchema.parse({ employeeId: manager, body: noteBody }));
    const own = await getEmployeeDevelopment(w.cityManagerA.actor, manager);
    expect(JSON.stringify(own)).not.toContain(noteBody);
    expect(own.coachingNotes ?? []).toEqual([]);
    expect(own.contextNotes ?? []).toEqual([]);
    expect(own.plans ?? []).toEqual([]);
  });
});

describe("P5-R2: managers do not act on their own development records", () => {
  it("refuses changes, reviews and transitions of a plan about the caller", async () => {
    const plan = await createPlan(
      w.stateManager.actor,
      ctx(w.stateManager.actor),
      createPlanSchema.parse({ employeeId: manager, title: "Own plan", periodStart: "2026-01-01", periodEnd: "2026-07-01" }),
    );
    const me = w.cityManagerA.actor;
    for (const attempt of [
      () => updatePlan(me, ctx(me), plan.id, updatePlanSchema.parse({ title: "Rewritten by the subject" })),
      () => addReview(me, ctx(me), plan.id, createReviewSchema.parse({ body: "Self review" })),
      () => activatePlan(me, ctx(me), plan.id),
      () => cancelPlan(me, ctx(me), plan.id, cancelPlanSchema.parse({ reason: "Not needed" })),
    ]) {
      // 404 like the read: a plan about the caller does not exist for them outside self-service.
      await expect(attempt()).rejects.toMatchObject({ httpStatus: 404 });
    }
    const after = await getPlan(w.hr.actor, plan.id);
    expect(after).toMatchObject({ title: "Own plan", status: "DRAFT" });
    expect(after.reviews).toHaveLength(0);
  });

  it("refuses accepting or dismissing a training recommendation about the caller", async () => {
    const { courseId, recommendationId } = await withTenant(w.tenantId, async (tx) => {
      const course = await tx.trainingCourse.create({ data: { tenantId: w.tenantId, code: `p5r2_${Date.now()}`, name: "Escalations", createdById: w.hr.userId } });
      const recommendation = await tx.trainingRecommendation.create({
        data: { tenantId: w.tenantId, employeeId: manager, courseId: course.id, reasons: [{ code: "CERTIFICATION_EXPIRING" }] },
      });
      return { courseId: course.id, recommendationId: recommendation.id };
    });
    const me = w.cityManagerA.actor;
    await expect(dismissRecommendation(me, ctx(me), recommendationId, dismissRecommendationSchema.parse({ reason: "I know this" }))).rejects.toMatchObject({ httpStatus: 403 });
    await expect(acceptRecommendation(me, ctx(me), recommendationId, acceptRecommendationSchema.parse({}))).rejects.toMatchObject({ httpStatus: 403 });
    const row = await withTenant(w.tenantId, (tx) => tx.trainingRecommendation.findUniqueOrThrow({ where: { id: recommendationId } }));
    expect(row.status).toBe("OPEN");
    // The State manager decides it.
    await acceptRecommendation(w.stateManager.actor, ctx(w.stateManager.actor), recommendationId, acceptRecommendationSchema.parse({}));
    const assignment = await withTenant(w.tenantId, (tx) => tx.trainingAssignment.findFirstOrThrow({ where: { employeeId: manager, courseId, status: "ASSIGNED" } }));
    // ...and the subject can neither push back the due date nor cancel what was assigned to them.
    await expect(updateAssignment(me, ctx(me), assignment.id, { dueDate: null })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cancelAssignment(me, ctx(me), assignment.id, { reason: "Busy" })).rejects.toMatchObject({ httpStatus: 403 });
    expect((await withTenant(w.tenantId, (tx) => tx.trainingAssignment.findUniqueOrThrow({ where: { id: assignment.id } }))).status).toBe("ASSIGNED");
  });

  it("still lets the manager change the training of the people they manage", async () => {
    const courseId = await withTenant(w.tenantId, async (tx) => (await tx.trainingCourse.create({ data: { tenantId: w.tenantId, code: `p5r2b_${Date.now()}`, name: "Brazing", createdById: w.hr.userId } })).id);
    const me = w.cityManagerA.actor;
    const assigned = await assignTraining(me, ctx(me), { employeeId: w.techA1.employeeId as string, courseId });
    expect((await cancelAssignment(me, ctx(me), assigned.id, { reason: "Duplicate" })).status).toBe("CANCELLED");
  });
});

describe("P5-R3: whoever edited a metric definition version never approves its publication", () => {
  it("the Owner who changed HR's draft cannot approve it; another publisher can", async () => {
    const draft = await makeDefinition(w, { kind: "OUTCOME_CONVERSION" }, "DRAFT");
    // The Owner holds performance.configure and performance.publish; they tighten the draft HR wrote.
    await updateDefinition(w.ceo.actor, ctx(w.ceo.actor), draft.id, updateDefinitionSchema.parse({ minSample: 7 }));
    const submitted = await submitDefinition(w.hr.actor, ctx(w.hr.actor), draft.id, submitDefinitionSchema.parse({}));
    const requestId = submitted.approvalRequestId as string;
    await expect(decideApprovalRequest(w.ceo.actor, ctx(w.ceo.actor), requestId, decideApprovalSchema.parse({ decision: "APPROVE" }))).rejects.toMatchObject({ httpStatus: 403 });
    const definition = await withTenant(w.tenantId, (tx) => tx.performanceMetricDefinition.findUniqueOrThrow({ where: { id: draft.id } }));
    expect(definition.status).toBe("PENDING_APPROVAL");

    // A publisher who did not write the content decides.
    const publisherRole = await makeRole(w.tenantId, "metric publisher", [{ permission: "performance.publish" }, { permission: "approvals.view" }]);
    const publisher = await createPerson(w.tenantId, "publisher", { withEmployee: false });
    await grantTemplate(w.tenantId, publisher, publisherRole, [{ type: "TENANT" }]);
    await decideApprovalRequest(publisher.actor, ctx(publisher.actor), requestId, decideApprovalSchema.parse({ decision: "APPROVE" }));
    const published = await withTenant(w.tenantId, (tx) => tx.performanceMetricDefinition.findUniqueOrThrow({ where: { id: draft.id } }));
    expect(published.status).toBe("PUBLISHED");
  });
});

describe("P5-R4: a computation never shows the caller their own preview values", () => {
  it("the manager computing a draft for their unit gets other people's previews, not their own", async () => {
    const draft = await makeDefinition(w, { kind: "TRAINING_PROGRESS" }, "DRAFT");
    const me = w.cityManagerA.actor;
    const employeeIds = [manager, w.techA1.employeeId as string];
    const result = await computeMetricValues(me, ctx(me), draft.id, computeValuesSchema.parse({ periodStart: "2026-02-01", periodEnd: "2026-03-01", employeeIds }));
    // TRAINING_PROGRESS writes one row per computed employee (sample 0 included): both were computed and stored.
    expect(result.employeeCount).toBe(2);
    const stored = await withTenant(w.tenantId, (tx) => tx.performanceMetricValue.findMany({ where: { definitionId: draft.id }, select: { employeeId: true } }));
    expect(stored.map((row) => row.employeeId).sort()).toEqual([...employeeIds].sort());
    // The answer leaves out the caller's own preview (they see their own values of published versions only).
    expect(result.values.map((value) => value.employeeId)).toEqual([w.techA1.employeeId]);
  });
});

describe("P5-R5: nobody records or voids customer feedback about themselves", () => {
  it("refuses a recorder or voider who is the employee the feedback is about", async () => {
    const jobId = await makeVisit(w, { employeeId: manager, completedAt: new Date("2026-02-12T15:00:00Z") });
    // Customer feedback rights for the manager, to isolate the self rule from the permission check.
    const role = await makeRole(w.tenantId, "feedback recorder", [
      { permission: "customer_feedback.view" },
      { permission: "customer_feedback.create" },
      { permission: "customer_feedback.edit" },
    ]);
    await grantTemplate(w.tenantId, w.cityManagerA, role, [{ type: "TENANT" }]);
    const me = w.cityManagerA.actor;
    await expect(recordCustomerFeedback(me, ctx(me), recordFeedbackSchema.parse({ jobId, employeeId: manager, rating: 5 }))).rejects.toMatchObject({ httpStatus: 403 });

    const agent = await createPerson(w.tenantId, "cr-agent", { withEmployee: false });
    await grantTemplate(w.tenantId, agent, w.roles.CUSTOMER_RELATIONS, [{ type: "TENANT" }]);
    const recorded = await recordCustomerFeedback(agent.actor, ctx(agent.actor), recordFeedbackSchema.parse({ jobId, employeeId: manager, rating: 1 }));
    await expect(voidCustomerFeedback(me, ctx(me), recorded.id, voidFeedbackSchema.parse({ reason: "Unfair" }))).rejects.toMatchObject({ httpStatus: 403 });
    // Feedback about the job only (nobody named) stays open to them.
    const aboutJob = await recordCustomerFeedback(me, ctx(me), recordFeedbackSchema.parse({ jobId, rating: 4 }));
    expect(aboutJob.employeeId).toBeNull();
  });
});
