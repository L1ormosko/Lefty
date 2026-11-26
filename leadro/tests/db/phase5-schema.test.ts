import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { METRIC_CONTEXT_NOTE_FIELD_MAP, PERFORMANCE_METRIC_VALUE_FIELD_MAP } from "@/server/authz";
import { createTenant } from "../helpers";

/**
 * Phase 5 schema (migration 20261126100000_phase5_workforce): tenant isolation of every new table, composite tenant- and
 * employee-safe foreign keys, CHECK constraints, status machines, frozen columns, append-only metric values and plan reviews,
 * and the metric value guard. Constraint, index and trigger names asserted here are part of the migration contract.
 */

interface Graph {
  tenantId: string;
  orgUnitId: string;
  managerUserId: string;
  hrUserId: string;
  employeeUserId: string;
  employeeId: string;
  otherEmployeeId: string;
  customerId: string;
  otherCustomerId: string;
  jobTypeId: string;
  jobId: string;
  trainingCertificationId: string;
  licenseCertificationId: string;
  qualificationId: string;
  courseId: string;
  assignmentId: string;
  recordId: string;
  policyId: string;
  definitionId: string;
  draftDefinitionId: string;
  trainingDefinitionId: string;
  feedbackDefinitionId: string;
  valueId: string;
  coachingId: string;
  planId: string;
  goalId: string;
  recommendationId: string;
  challengeId: string;
  feedbackId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
let counter = 0;
const key = (prefix: string) => `${prefix}_${suffix}_${(counter += 1)}`;
let A: Graph;
let B: Graph;

async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "BRANCH", name: `Branch ${label}` } });
    const manager = await tx.user.create({ data: { tenantId, email: `m-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const hr = await tx.user.create({ data: { tenantId, email: `h-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const employeeUser = await tx.user.create({ data: { tenantId, email: `e-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const employee = await tx.employee.create({ data: { tenantId, userId: employeeUser.id, firstName: "Tech", lastName: label } });
    const otherEmployee = await tx.employee.create({ data: { tenantId, firstName: "Other", lastName: label } });
    const customer = await tx.customer.create({ data: { tenantId, number: 1, name: "Ann Customer", orgUnitId: orgUnit.id } });
    const otherCustomer = await tx.customer.create({ data: { tenantId, number: 2, name: "Bob Customer", orgUnitId: orgUnit.id } });
    const address = await tx.customerAddress.create({
      data: { tenantId, customerId: customer.id, line1: "1 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: `k-${label}` },
    });
    const jobType = await tx.jobType.create({ data: { tenantId, code: "ac-install", name: "AC installation", category: "installation", defaultDurationMinutes: 180 } });
    const job = await tx.job.create({
      data: { tenantId, number: 1, customerId: customer.id, serviceAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, title: "Install AC", estimatedDurationMinutes: 180 },
    });
    const trainingCert = await tx.certification.create({ data: { tenantId, code: "safety-101", name: "Safety 101", type: "TRAINING" } });
    const licenseCert = await tx.certification.create({ data: { tenantId, code: "epa-608", name: "EPA 608", type: "LICENSE" } });
    const qualification = await tx.employeeQualification.create({
      data: { tenantId, employeeId: employee.id, kind: "TRAINING", certificationId: trainingCert.id, status: "VERIFIED", verifiedById: hr.id, verifiedAt: new Date() },
    });
    const course = await tx.trainingCourse.create({
      data: { tenantId, code: "safety-101", name: "Safety basics", category: "safety", certificationId: trainingCert.id, validityDays: 365, createdById: hr.id },
    });
    const record = await tx.trainingRecord.create({
      data: { tenantId, employeeId: employee.id, courseId: course.id, completedAt: new Date("2026-03-01T15:00:00Z"), recordedById: hr.id },
    });
    const assignment = await tx.trainingAssignment.create({
      data: { tenantId, employeeId: employee.id, courseId: course.id, dueDate: new Date("2026-04-01"), assignedById: manager.id },
    });
    const policy = await tx.approvalPolicy.create({
      data: { tenantId, code: "metric_publication", subjectType: "PERFORMANCE_METRIC_DEFINITION", name: "Metric publication", approverPermission: "performance.publish", createdById: hr.id },
    });
    const request = await tx.approvalRequest.create({
      data: {
        tenantId, subjectType: "PERFORMANCE_METRIC_DEFINITION", subjectId: "pending", policyId: policy.id, policyCode: policy.code, policyVersion: 1,
        requiredApprovals: 1, approverPermission: "performance.publish", requestedById: hr.id,
      },
    });
    const definition = await tx.performanceMetricDefinition.create({
      data: {
        tenantId, key: "on_time_arrival", kind: "ON_TIME_ARRIVAL", dimension: "TIMELINESS", name: "On-time arrival", minSample: 5,
        status: "PUBLISHED", approvalRequestId: request.id, submittedAt: new Date(), publishedAt: new Date(), createdById: hr.id,
      },
    });
    const draft = await tx.performanceMetricDefinition.create({
      data: { tenantId, key: "repeat_visits", kind: "REPEAT_VISIT_RATE", dimension: "REPEAT_VISITS", name: "Repeat visits", params: { windowDays: 30 }, minSample: 10, createdById: hr.id },
    });
    const trainingDefinition = await tx.performanceMetricDefinition.create({
      data: { tenantId, key: "training_progress", kind: "TRAINING_PROGRESS", dimension: "TRAINING_PROGRESS", name: "Training progress", minSample: 1, createdById: hr.id },
    });
    const feedbackDefinition = await tx.performanceMetricDefinition.create({
      data: { tenantId, key: "feedback", kind: "CUSTOMER_FEEDBACK_AVERAGE", dimension: "CUSTOMER_FEEDBACK", name: "Feedback", minSample: 3, createdById: hr.id },
    });
    const value = await tx.performanceMetricValue.create({
      data: {
        tenantId, definitionId: definition.id, employeeId: employee.id, orgUnitId: orgUnit.id, periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-04-01"),
        jobTypeId: jobType.id, numerator: 4, denominator: 6, sampleSize: 6, enoughData: true, evidenceIds: ["av1", "av2"], systemActor: "system:performance",
      },
    });
    const coaching = await tx.coachingRecord.create({ data: { tenantId, employeeId: employee.id, authorId: manager.id, body: "Talked about arrival windows.", metricValueId: value.id } });
    await tx.metricContextNote.create({ data: { tenantId, employeeId: employee.id, metricValueId: value.id, body: "Two jobs had a parts delay.", authorId: manager.id } });
    const plan = await tx.developmentPlan.create({
      data: { tenantId, employeeId: employee.id, ownerId: manager.id, title: "Q2 plan", periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-07-01"), createdById: manager.id },
    });
    const goal = await tx.developmentGoal.create({ data: { tenantId, planId: plan.id, title: "Arrive on time", metricDefinitionId: definition.id } });
    await tx.developmentAction.create({
      data: { tenantId, planId: plan.id, employeeId: employee.id, goalId: goal.id, kind: "TRAINING", description: "Take the safety course", trainingAssignmentId: assignment.id },
    });
    await tx.developmentPlanReview.create({ data: { tenantId, planId: plan.id, reviewerId: manager.id, planStatus: "DRAFT", body: "Plan drafted." } });
    const recommendation = await tx.trainingRecommendation.create({
      data: { tenantId, employeeId: employee.id, courseId: course.id, reasons: [{ code: "certification_expiring", qualificationId: qualification.id }] },
    });
    const challenge = await tx.dataChallenge.create({
      data: { tenantId, employeeId: employee.id, targetType: "PERFORMANCE_METRIC_VALUE", metricValueId: value.id, statement: "One visit was rescheduled by the customer.", raisedById: employeeUser.id },
    });
    const feedback = await tx.customerFeedback.create({
      data: { tenantId, jobId: job.id, customerId: customer.id, employeeId: employee.id, rating: 5, comment: "Great", orgUnitId: orgUnit.id, recordedById: manager.id },
    });
    return {
      tenantId, orgUnitId: orgUnit.id, managerUserId: manager.id, hrUserId: hr.id, employeeUserId: employeeUser.id, employeeId: employee.id,
      otherEmployeeId: otherEmployee.id, customerId: customer.id, otherCustomerId: otherCustomer.id, jobTypeId: jobType.id, jobId: job.id,
      trainingCertificationId: trainingCert.id, licenseCertificationId: licenseCert.id, qualificationId: qualification.id, courseId: course.id,
      assignmentId: assignment.id, recordId: record.id, policyId: policy.id, definitionId: definition.id, draftDefinitionId: draft.id,
      trainingDefinitionId: trainingDefinition.id, feedbackDefinitionId: feedbackDefinition.id, valueId: value.id, coachingId: coaching.id,
      planId: plan.id, goalId: goal.id, recommendationId: recommendation.id, challengeId: challenge.id, feedbackId: feedback.id,
    };
  });
}

beforeAll(async () => {
  A = await buildGraph("p5a");
  B = await buildGraph("p5b");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) => expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);
const run = <T>(g: Graph, fn: (tx: TenantTx) => Promise<T>) => withTenant(g.tenantId, fn);

/** A valid metric value for graph `g`; `over` overrides columns. */
const value = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, definitionId: g.definitionId, employeeId: g.employeeId, periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-05-01"),
  jobTypeId: g.jobTypeId, numerator: 1, denominator: 2, sampleSize: 2, enoughData: false, computedById: g.managerUserId, ...over,
});

const challenge = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, employeeId: g.employeeId, targetType: "TRAINING_RECORD" as const, trainingRecordId: g.recordId, statement: "Wrong date.", raisedById: g.employeeUserId, ...over,
});

describe("tenant isolation of every Phase 5 table", () => {
  const TABLES = [
    "TrainingCourse", "TrainingAssignment", "TrainingRecord", "PerformanceMetricDefinition", "PerformanceMetricValue", "MetricContextNote",
    "CoachingRecord", "DevelopmentPlan", "DevelopmentGoal", "DevelopmentAction", "DevelopmentPlanReview", "TrainingRecommendation",
    "DataChallenge", "CustomerFeedback",
  ];

  it.each(TABLES)("%s: each tenant sees only its own rows, and nothing without a tenant context", async (table) => {
    const own = (g: Graph) =>
      withTenant(g.tenantId, async (tx) => (await tx.$queryRawUnsafe<{ tenantId: string }[]>(`SELECT "tenantId" FROM "${table}"`)).map((r) => r.tenantId));
    expect(new Set(await own(A))).toEqual(new Set([A.tenantId]));
    expect(new Set(await own(B))).toEqual(new Set([B.tenantId]));
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
  });

  it("a tenant cannot insert a Phase 5 row under another tenant's id", async () => {
    await rejects(A, /row-level security/, (tx) => tx.trainingCourse.create({ data: { tenantId: B.tenantId, code: "smuggled", name: "Smuggled" } }));
    await rejects(A, /row-level security/, (tx) => tx.coachingRecord.create({ data: { tenantId: B.tenantId, employeeId: B.employeeId, authorId: B.managerUserId, body: "x" } }));
  });
});

describe("composite foreign keys keep references inside one tenant and on one employee", () => {
  it("cannot point at another tenant's rows", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.trainingAssignment.create({ data: { tenantId: A.tenantId, employeeId: B.employeeId, courseId: A.courseId, assignedById: A.managerUserId } }));
    await rejects(A, /foreign key/i, (tx) => tx.coachingRecord.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, authorId: B.managerUserId, body: "x" } }));
    await rejects(A, /foreign key/i, (tx) => tx.performanceMetricValue.create({ data: value(A, { definitionId: B.definitionId }) }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.customerFeedback.create({ data: { tenantId: A.tenantId, jobId: B.jobId, customerId: B.customerId, rating: 3, recordedById: A.managerUserId } }),
    );
  });

  it("a course can only grant a TRAINING-type certification", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: key("lic"), name: "License prep", certificationId: A.licenseCertificationId } }));
    await rejects(A, "training_course_certification_kind", (tx) =>
      tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: key("lic"), name: "License prep", certificationId: A.licenseCertificationId, certificationKind: "LICENSE" } }),
    );
  });

  it("links to a value, record, coaching note, assignment or plan must be about the same employee", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.coachingRecord.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, authorId: A.managerUserId, body: "x", metricValueId: A.valueId } }));
    await rejects(A, /foreign key/i, (tx) => tx.metricContextNote.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, metricValueId: A.valueId, body: "x", authorId: A.managerUserId } }));
    await rejects(A, /foreign key/i, (tx) => tx.dataChallenge.create({ data: challenge(A, { employeeId: A.otherEmployeeId }) }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.dataChallenge.create({ data: challenge(A, { employeeId: A.otherEmployeeId, targetType: "EMPLOYEE_QUALIFICATION", trainingRecordId: null, qualificationId: A.qualificationId }) }),
    );
    const otherPlan = await run(A, (tx) =>
      tx.developmentPlan.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, ownerId: A.managerUserId, title: "Other", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01") } }),
    );
    // The action copies the plan's employee; the training assignment belongs to someone else.
    await rejects(A, /foreign key/i, (tx) =>
      tx.developmentAction.create({ data: { tenantId: A.tenantId, planId: otherPlan.id, employeeId: A.otherEmployeeId, kind: "TRAINING", description: "x", trainingAssignmentId: A.assignmentId } }),
    );
    // ... and cannot pretend the plan belongs to the assignment's employee.
    await rejects(A, /foreign key/i, (tx) =>
      tx.developmentAction.create({ data: { tenantId: A.tenantId, planId: otherPlan.id, employeeId: A.employeeId, kind: "TRAINING", description: "x", trainingAssignmentId: A.assignmentId } }),
    );
    // A goal of another plan.
    await rejects(A, /foreign key/i, (tx) =>
      tx.developmentAction.create({ data: { tenantId: A.tenantId, planId: otherPlan.id, employeeId: A.otherEmployeeId, goalId: A.goalId, kind: "OTHER", description: "x" } }),
    );
  });

  it("an assignment's recommendation and fulfilling record are of the same employee and course", async () => {
    const otherCourse = await run(A, (tx) => tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: key("c"), name: "Other course" } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.trainingAssignment.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, courseId: otherCourse.id, source: "RECOMMENDATION", recommendationId: A.recommendationId, assignedById: A.managerUserId } }),
    );
    await rejects(A, /foreign key/i, (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { trainingRecordId: "not-a-record" } }));
  });

  it("customer feedback's customer is the job's customer", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.customerFeedback.create({ data: { tenantId: A.tenantId, jobId: A.jobId, customerId: A.otherCustomerId, rating: 4, recordedById: A.managerUserId } }),
    );
  });
});

describe("training", () => {
  it("checks course codes, names and validity", async () => {
    await rejects(A, "training_course_code_format", (tx) => tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: "Bad Code", name: "x" } }));
    await rejects(A, "training_course_name_present", (tx) => tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: key("c"), name: "  " } }));
    await rejects(A, "training_course_validity_range", (tx) => tx.trainingCourse.create({ data: { tenantId: A.tenantId, code: key("c"), name: "x", validityDays: 0 } }));
    await rejects(A, /immutable/, (tx) => tx.trainingCourse.update({ where: { id: A.courseId }, data: { code: "renamed" } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "TrainingCourse" WHERE "id" = ${A.courseId}`);
  });

  it("allows one open assignment per employee and course, with a recommendation exactly when the source says so", async () => {
    await rejects(A, /training_assignment_one_open|Unique constraint/, (tx) =>
      tx.trainingAssignment.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, courseId: A.courseId, assignedById: A.managerUserId } }),
    );
    await rejects(A, "training_assignment_source_recommendation", (tx) =>
      tx.trainingAssignment.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, courseId: A.courseId, source: "RECOMMENDATION", assignedById: A.managerUserId } }),
    );
  });

  it("an assignment moves forward only, completes with its record and cancels with a reason", async () => {
    await rejects(A, "training_assignment_completed", (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { status: "COMPLETED", completedAt: new Date() } }));
    await rejects(A, "training_assignment_cancelled", (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { status: "CANCELLED", cancelledAt: new Date() } }));
    const done = await run(A, (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { status: "COMPLETED", completedAt: new Date(), trainingRecordId: A.recordId } }));
    expect(done.status).toBe("COMPLETED");
    await rejects(A, /status transition COMPLETED -> ASSIGNED/, (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { status: "ASSIGNED" } }));
    await rejects(A, /immutable/, (tx) => tx.trainingAssignment.update({ where: { id: A.assignmentId }, data: { assignedById: A.hrUserId } }));
    // The completed one no longer blocks a new assignment of the same course.
    await run(A, (tx) => tx.trainingAssignment.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, courseId: A.courseId, assignedById: A.managerUserId } }));
  });

  it("a record is decided by HR with a reason when rejected, and its evidence is described completely", async () => {
    const base = { tenantId: A.tenantId, employeeId: A.employeeId, courseId: A.courseId, completedAt: new Date("2026-03-10T12:00:00Z"), recordedById: A.hrUserId };
    await rejects(A, "training_record_decided", (tx) => tx.trainingRecord.create({ data: { ...base, status: "VERIFIED" } }));
    await rejects(A, "training_record_decision_reason", (tx) => tx.trainingRecord.create({ data: { ...base, status: "REJECTED", verifiedById: A.hrUserId, verifiedAt: new Date() } }));
    await rejects(A, "training_record_evidence_file_complete", (tx) => tx.trainingRecord.create({ data: { ...base, evidenceFileName: "cert.pdf" } }));
    await rejects(A, "training_record_evidence_checksum_format", (tx) => tx.trainingRecord.create({ data: { ...base, evidenceChecksumSha256: "abc" } }));
    await rejects(A, "training_record_evidence_storage_needs_file", (tx) => tx.trainingRecord.create({ data: { ...base, evidenceStorageKey: "k" } }));
    await rejects(A, "training_record_expiry_after_completion", (tx) => tx.trainingRecord.create({ data: { ...base, expiresAt: new Date("2026-03-01") } }));
    await rejects(A, "training_record_qualification_only_when_verified", (tx) => tx.trainingRecord.create({ data: { ...base, qualificationId: A.qualificationId } }));
    const created = await run(A, (tx) =>
      tx.trainingRecord.create({ data: { ...base, evidenceFileName: "cert.pdf", evidenceContentType: "application/pdf", evidenceSizeBytes: 2048, evidenceReference: "CERT-1" } }),
    );
    await rejects(A, /immutable/, (tx) => tx.trainingRecord.update({ where: { id: created.id }, data: { evidenceReference: "CERT-2" } }));
    const verified = await run(A, (tx) =>
      tx.trainingRecord.update({ where: { id: created.id }, data: { status: "VERIFIED", verifiedById: A.hrUserId, verifiedAt: new Date(), qualificationId: A.qualificationId } }),
    );
    expect(verified.status).toBe("VERIFIED");
    await rejects(A, /status transition VERIFIED -> PENDING_VERIFICATION/, (tx) => tx.trainingRecord.update({ where: { id: created.id }, data: { status: "PENDING_VERIFICATION" } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "TrainingRecord" WHERE "id" = ${created.id}`);
  });
});

describe("performance metric definitions", () => {
  it("pins each kind to its dimension and checks key, sample and params", async () => {
    const data = { tenantId: A.tenantId, key: key("k"), kind: "ON_TIME_ARRIVAL" as const, dimension: "TIMELINESS" as const, name: "x", minSample: 1 };
    await rejects(A, "performance_metric_definition_kind_dimension", (tx) => tx.performanceMetricDefinition.create({ data: { ...data, dimension: "SALES" } }));
    await rejects(A, "performance_metric_definition_key_format", (tx) => tx.performanceMetricDefinition.create({ data: { ...data, key: "Bad-Key" } }));
    await rejects(A, "performance_metric_definition_min_sample_positive", (tx) => tx.performanceMetricDefinition.create({ data: { ...data, minSample: 0 } }));
    await rejects(A, "performance_metric_definition_params_object", (tx) => tx.performanceMetricDefinition.create({ data: { ...data, params: [1, 2] } }));
  });

  it("publishing always names an approval request, and one version per key is published", async () => {
    await rejects(A, "performance_metric_definition_needs_approval", (tx) =>
      tx.performanceMetricDefinition.update({ where: { id: A.draftDefinitionId }, data: { status: "PENDING_APPROVAL", submittedAt: new Date() } }),
    );
    const request = await run(A, (tx) =>
      tx.approvalRequest.create({
        data: {
          tenantId: A.tenantId, subjectType: "PERFORMANCE_METRIC_DEFINITION", subjectId: key("s"), policyId: A.policyId, policyCode: "metric_publication", policyVersion: 1,
          requiredApprovals: 1, approverPermission: "performance.publish", requestedById: A.hrUserId,
        },
      }),
    );
    const v2 = await run(A, (tx) =>
      tx.performanceMetricDefinition.create({
        data: { tenantId: A.tenantId, key: "on_time_arrival", version: 2, kind: "ON_TIME_ARRIVAL", dimension: "TIMELINESS", name: "On-time arrival", minSample: 8 },
      }),
    );
    await rejects(A, /performance_metric_definition_one_published|Unique constraint/, (tx) =>
      tx.performanceMetricDefinition.update({ where: { id: v2.id }, data: { status: "PENDING_APPROVAL", submittedAt: new Date(), approvalRequestId: request.id } }).then(() =>
        tx.performanceMetricDefinition.update({ where: { id: v2.id }, data: { status: "PUBLISHED", publishedAt: new Date() } }),
      ),
    );
    await rejects(A, /status transition DRAFT -> PUBLISHED/, (tx) =>
      tx.performanceMetricDefinition.update({ where: { id: v2.id }, data: { status: "PUBLISHED", publishedAt: new Date(), approvalRequestId: request.id } }),
    );
    await rejects(A, /Unique constraint|tenantId_key_version/, (tx) =>
      tx.performanceMetricDefinition.create({ data: { tenantId: A.tenantId, key: "on_time_arrival", version: 2, kind: "ON_TIME_ARRIVAL", dimension: "TIMELINESS", name: "dup", minSample: 1 } }),
    );
  });

  it("freezes a version's content once it leaves DRAFT", async () => {
    await run(A, (tx) => tx.performanceMetricDefinition.update({ where: { id: A.draftDefinitionId }, data: { minSample: 12, params: { windowDays: 14 } } }));
    await rejects(A, /frozen/, (tx) => tx.performanceMetricDefinition.update({ where: { id: A.definitionId }, data: { minSample: 1 } }));
    await rejects(A, /frozen/, (tx) => tx.performanceMetricDefinition.update({ where: { id: A.definitionId }, data: { name: "Renamed" } }));
    await rejects(A, /immutable/, (tx) => tx.performanceMetricDefinition.update({ where: { id: A.draftDefinitionId }, data: { version: 9 } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "PerformanceMetricDefinition" WHERE "id" = ${A.draftDefinitionId}`);
  });
});

describe("performance metric values", () => {
  it("are append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`UPDATE "PerformanceMetricValue" SET "numerator" = 0 WHERE "id" = ${A.valueId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`DELETE FROM "PerformanceMetricValue" WHERE "id" = ${A.valueId}`);
    await rejects(A, /append-only|referenced in a foreign key/, (tx) => tx.$executeRawUnsafe(`TRUNCATE "PerformanceMetricValue" CASCADE`));
  });

  it("a recomputation is a new row; the newest computedAt is current", async () => {
    const later = await run(A, (tx) => tx.performanceMetricValue.create({ data: value(A, { periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-04-01"), numerator: 5, denominator: 6, sampleSize: 6, enoughData: true, computedAt: new Date(Date.now() + 1000) }) }));
    const current = await run(A, (tx) =>
      tx.performanceMetricValue.findFirst({ where: { definitionId: A.definitionId, employeeId: A.employeeId, periodStart: new Date("2026-03-01"), jobTypeId: A.jobTypeId }, orderBy: { computedAt: "desc" } }),
    );
    expect(current?.id).toBe(later.id);
  });

  it("checks counts, period, breakdown and actor", async () => {
    await rejects(A, "performance_metric_value_counts_nonnegative", (tx) => tx.performanceMetricValue.create({ data: value(A, { numerator: -1 }) }));
    await rejects(A, "performance_metric_value_period", (tx) => tx.performanceMetricValue.create({ data: value(A, { periodEnd: new Date("2026-04-01") }) }));
    await rejects(A, "performance_metric_value_one_breakdown", (tx) => tx.performanceMetricValue.create({ data: value(A, { jobCategory: "installation" }) }));
    await rejects(A, "performance_metric_value_one_actor", (tx) => tx.performanceMetricValue.create({ data: value(A, { systemActor: "system:performance" }) }));
    await rejects(A, "performance_metric_value_system_actor_format", (tx) => tx.performanceMetricValue.create({ data: value(A, { computedById: null, systemActor: "performance" }) }));
  });

  it("the guard checks the value against its definition: breakdown, numerator range and the not-enough-data flag", async () => {
    await rejects(A, /numerator cannot exceed/, (tx) => tx.performanceMetricValue.create({ data: value(A, { numerator: 3, denominator: 2 }) }));
    await rejects(A, /needs a job type or a job category/, (tx) => tx.performanceMetricValue.create({ data: value(A, { jobTypeId: null }) }));
    await rejects(A, /enoughData must equal/, (tx) => tx.performanceMetricValue.create({ data: value(A, { sampleSize: 5, enoughData: false }) }));
    await rejects(A, /enoughData must equal/, (tx) => tx.performanceMetricValue.create({ data: value(A, { sampleSize: 4, enoughData: true }) }));
    await rejects(A, /not broken down/, (tx) => tx.performanceMetricValue.create({ data: value(A, { definitionId: A.trainingDefinitionId, sampleSize: 1, enoughData: true }) }));
    const training = await run(A, (tx) => tx.performanceMetricValue.create({ data: value(A, { definitionId: A.trainingDefinitionId, jobTypeId: null, sampleSize: 1, enoughData: true }) }));
    expect(training.jobTypeId).toBeNull();
    // Feedback average: numerator = sum of 1-5 ratings over `denominator` ratings.
    const feedback = (numerator: number, denominator: number) =>
      value(A, { definitionId: A.feedbackDefinitionId, jobTypeId: null, jobCategory: "installation", numerator, denominator, sampleSize: denominator, enoughData: denominator >= 3 });
    await run(A, (tx) => tx.performanceMetricValue.create({ data: feedback(14, 3) }));
    await rejects(A, /rating sum/, (tx) => tx.performanceMetricValue.create({ data: feedback(16, 3) }));
    await rejects(A, /rating sum/, (tx) => tx.performanceMetricValue.create({ data: feedback(2, 3) }));
    await rejects(A, "performance_metric_value_category_present", (tx) => tx.performanceMetricValue.create({ data: value(A, { jobTypeId: null, jobCategory: " " }) }));
  });
});

describe("context notes and coaching", () => {
  it("a context note is about a value or a period; what it says never changes", async () => {
    await rejects(A, "metric_context_note_subject", (tx) => tx.metricContextNote.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, body: "x", authorId: A.managerUserId } }));
    await rejects(A, "metric_context_note_period", (tx) =>
      tx.metricContextNote.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-03-01"), body: "x", authorId: A.managerUserId } }),
    );
    const note = await run(A, (tx) =>
      tx.metricContextNote.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-04-01"), body: "Was on leave two weeks.", authorId: A.managerUserId } }),
    );
    await rejects(A, /immutable/, (tx) => tx.metricContextNote.update({ where: { id: note.id }, data: { body: "Edited" } }));
    await rejects(A, "metric_context_note_shared_at", (tx) => tx.metricContextNote.update({ where: { id: note.id }, data: { sharedWithEmployee: true } }));
    await run(A, (tx) => tx.metricContextNote.update({ where: { id: note.id }, data: { sharedWithEmployee: true, sharedAt: new Date() } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "MetricContextNote" WHERE "id" = ${note.id}`);
  });

  it("a coaching note keeps its employee and author, is shared explicitly and never deleted", async () => {
    await rejects(A, "coaching_record_body_present", (tx) => tx.coachingRecord.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, authorId: A.managerUserId, body: " " } }));
    await rejects(A, /immutable/, (tx) => tx.coachingRecord.update({ where: { id: A.coachingId }, data: { authorId: A.hrUserId } }));
    await rejects(A, "coaching_record_shared_at", (tx) => tx.coachingRecord.update({ where: { id: A.coachingId }, data: { sharedAt: new Date() } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "CoachingRecord" WHERE "id" = ${A.coachingId}`);
  });
});

describe("development plans", () => {
  it("checks period, lifecycle and frozen columns", async () => {
    await rejects(A, "development_plan_period", (tx) =>
      tx.developmentPlan.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, ownerId: A.managerUserId, title: "x", periodStart: new Date("2026-04-01"), periodEnd: new Date("2026-04-01") } }),
    );
    await rejects(A, "development_plan_activated_at", (tx) => tx.developmentPlan.update({ where: { id: A.planId }, data: { status: "ACTIVE" } }));
    await rejects(A, /status transition DRAFT -> COMPLETED/, (tx) => tx.developmentPlan.update({ where: { id: A.planId }, data: { status: "COMPLETED", activatedAt: new Date(), completedAt: new Date() } }));
    await run(A, (tx) => tx.developmentPlan.update({ where: { id: A.planId }, data: { status: "ACTIVE", activatedAt: new Date() } }));
    await rejects(A, "development_plan_cancelled", (tx) => tx.developmentPlan.update({ where: { id: A.planId }, data: { status: "CANCELLED", cancelledAt: new Date() } }));
    await rejects(A, /immutable/, (tx) => tx.developmentPlan.update({ where: { id: A.planId }, data: { employeeId: A.otherEmployeeId } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "DevelopmentPlan" WHERE "id" = ${A.planId}`);
  });

  it("an action's kind decides its links", async () => {
    const action = (kind: "TRAINING" | "COACHING" | "OTHER", over: { trainingAssignmentId?: string; coachingRecordId?: string } = {}) => ({
      tenantId: A.tenantId, planId: A.planId, employeeId: A.employeeId, description: "Do it", kind, ...over,
    });
    await rejects(A, "development_action_links", (tx) => tx.developmentAction.create({ data: action("TRAINING") }));
    await rejects(A, "development_action_links", (tx) => tx.developmentAction.create({ data: action("OTHER", { trainingAssignmentId: A.assignmentId }) }));
    await rejects(A, "development_action_links", (tx) => tx.developmentAction.create({ data: action("OTHER", { coachingRecordId: A.coachingId }) }));
    const coaching = await run(A, (tx) => tx.developmentAction.create({ data: action("COACHING", { coachingRecordId: A.coachingId }) }));
    await rejects(A, "development_action_completed_at", (tx) => tx.developmentAction.update({ where: { id: coaching.id }, data: { status: "DONE" } }));
    await rejects(A, /immutable/, (tx) => tx.developmentAction.update({ where: { id: coaching.id }, data: { kind: "OTHER", coachingRecordId: null } }));
  });

  it("goals of a plan: title required, achieved needs a date", async () => {
    await rejects(A, "development_goal_title_present", (tx) => tx.developmentGoal.create({ data: { tenantId: A.tenantId, planId: A.planId, title: "" } }));
    await rejects(A, "development_goal_achieved_at", (tx) => tx.developmentGoal.update({ where: { id: A.goalId }, data: { status: "ACHIEVED" } }));
  });

  it("review history is append-only", async () => {
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`UPDATE "DevelopmentPlanReview" SET "body" = 'x' WHERE "planId" = ${A.planId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`DELETE FROM "DevelopmentPlanReview" WHERE "planId" = ${A.planId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRawUnsafe(`TRUNCATE "DevelopmentPlanReview"`));
  });
});

describe("training recommendations", () => {
  it("need at least one reason, one open per employee and course, and a reason to dismiss", async () => {
    await rejects(A, "training_recommendation_reasons_present", (tx) => tx.trainingRecommendation.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, courseId: A.courseId, reasons: [] } }));
    await rejects(A, /training_recommendation_one_open|Unique constraint/, (tx) =>
      tx.trainingRecommendation.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, courseId: A.courseId, reasons: [{ code: "x" }] } }),
    );
    await rejects(A, "training_recommendation_dismiss_reason", (tx) => tx.trainingRecommendation.update({ where: { id: A.recommendationId }, data: { status: "DISMISSED", decidedAt: new Date() } }));
    await rejects(A, /immutable/, (tx) => tx.trainingRecommendation.update({ where: { id: A.recommendationId }, data: { reasons: [{ code: "changed" }] } }));
  });

  it("accepting links exactly one assignment of the same employee and course", async () => {
    const accepted = await run(A, (tx) => tx.trainingRecommendation.update({ where: { id: A.recommendationId }, data: { status: "ACCEPTED", decidedAt: new Date(), decidedById: A.managerUserId } }));
    expect(accepted.status).toBe("ACCEPTED");
    await rejects(A, /status transition ACCEPTED -> DISMISSED/, (tx) => tx.trainingRecommendation.update({ where: { id: A.recommendationId }, data: { status: "DISMISSED", dismissReason: "x" } }));
    // B's graph: the recommendation's assignment (no other open assignment there for this course on otherEmployee).
    const recommendation = await run(B, (tx) => tx.trainingRecommendation.create({ data: { tenantId: B.tenantId, employeeId: B.otherEmployeeId, courseId: B.courseId, reasons: [{ code: "manual" }] } }));
    await run(B, (tx) =>
      tx.trainingAssignment.create({ data: { tenantId: B.tenantId, employeeId: B.otherEmployeeId, courseId: B.courseId, source: "RECOMMENDATION", recommendationId: recommendation.id, assignedById: B.managerUserId } }),
    );
  });
});

describe("data challenges", () => {
  it("has exactly one target of the declared type", async () => {
    await rejects(A, "data_challenge_target_matches_type", (tx) => tx.dataChallenge.create({ data: challenge(A, { targetType: "COACHING_RECORD" }) }));
    await rejects(A, "data_challenge_target_matches_type", (tx) => tx.dataChallenge.create({ data: challenge(A, { coachingRecordId: A.coachingId }) }));
    await rejects(A, "data_challenge_statement_present", (tx) => tx.dataChallenge.create({ data: challenge(A, { statement: " " }) }));
  });

  it("one open challenge per target", async () => {
    await rejects(A, /data_challenge_one_open_per_target|Unique constraint/, (tx) =>
      tx.dataChallenge.create({ data: challenge(A, { targetType: "PERFORMANCE_METRIC_VALUE", trainingRecordId: null, metricValueId: A.valueId }) }),
    );
  });

  it("is reviewed by someone else, resolved with a text, and keeps what was challenged", async () => {
    await rejects(A, "data_challenge_reviewer_assigned", (tx) => tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "UNDER_REVIEW" } }));
    await rejects(A, "data_challenge_reviewer_not_raiser", (tx) =>
      tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "UNDER_REVIEW", reviewerId: A.employeeUserId, assignedAt: new Date() } }),
    );
    await rejects(A, /status transition OPEN -> UPHELD/, (tx) =>
      tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "UPHELD", reviewerId: A.hrUserId, assignedAt: new Date(), resolutionKind: "ANNOTATED", resolution: "x", resolvedById: A.hrUserId, resolvedAt: new Date() } }),
    );
    await run(A, (tx) => tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "UNDER_REVIEW", reviewerId: A.hrUserId, assignedAt: new Date() } }));
    await rejects(A, "data_challenge_upheld", (tx) => tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "UPHELD", resolution: "Noted", resolvedById: A.hrUserId, resolvedAt: new Date() } }));
    await rejects(A, "data_challenge_resolution_kind_only_upheld", (tx) =>
      tx.dataChallenge.update({ where: { id: A.challengeId }, data: { status: "REJECTED", resolutionKind: "ANNOTATED", resolution: "No", resolvedById: A.hrUserId, resolvedAt: new Date() } }),
    );
    await rejects(A, /immutable/, (tx) => tx.dataChallenge.update({ where: { id: A.challengeId }, data: { statement: "Edited" } }));
    const upheld = await run(A, (tx) =>
      tx.dataChallenge.update({
        where: { id: A.challengeId },
        data: { status: "UPHELD", resolutionKind: "ANNOTATED", resolution: "The customer moved the appointment.", resolvedById: A.hrUserId, resolvedAt: new Date() },
      }),
    );
    expect(upheld.status).toBe("UPHELD");
    // Resolved: the target can be challenged again.
    await run(A, (tx) => tx.dataChallenge.create({ data: challenge(A, { targetType: "PERFORMANCE_METRIC_VALUE", trainingRecordId: null, metricValueId: A.valueId }) }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "DataChallenge" WHERE "id" = ${A.challengeId}`);
  });
});

describe("customer feedback", () => {
  const feedback = (over: Record<string, unknown> = {}) => ({ tenantId: A.tenantId, jobId: A.jobId, customerId: A.customerId, recordedById: A.managerUserId, ...over });

  it("a rating is 1-5, and there is a rating or a comment", async () => {
    await rejects(A, "customer_feedback_rating_range", (tx) => tx.customerFeedback.create({ data: feedback({ rating: 6 }) }));
    await rejects(A, "customer_feedback_rating_range", (tx) => tx.customerFeedback.create({ data: feedback({ rating: 0 }) }));
    await rejects(A, "customer_feedback_content", (tx) => tx.customerFeedback.create({ data: feedback({ comment: "  " }) }));
    await run(A, (tx) => tx.customerFeedback.create({ data: feedback({ comment: "Came on time." }) }));
  });

  it("is never edited, only voided once with a reason", async () => {
    await rejects(A, /immutable/, (tx) => tx.customerFeedback.update({ where: { id: A.feedbackId }, data: { rating: 1 } }));
    await rejects(A, "customer_feedback_voided", (tx) => tx.customerFeedback.update({ where: { id: A.feedbackId }, data: { voidedAt: new Date(), voidedById: A.managerUserId } }));
    await run(A, (tx) => tx.customerFeedback.update({ where: { id: A.feedbackId }, data: { voidedAt: new Date(), voidedById: A.managerUserId, voidReason: "Wrong job" } }));
    await rejects(A, /voided once/, (tx) => tx.customerFeedback.update({ where: { id: A.feedbackId }, data: { voidedAt: null, voidedById: null, voidReason: null } }));
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "CustomerFeedback" WHERE "id" = ${A.feedbackId}`);
  });
});

describe("migration contract", () => {
  it("creates the named partial unique indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const name of [
      "training_assignment_one_open", "performance_metric_definition_one_published", "training_recommendation_one_open", "data_challenge_one_open_per_target",
      "PerformanceMetricValue_team_job_type_idx", "PerformanceMetricValue_team_job_category_idx", "EmployeeQualification_id_employeeId_tenantId_key",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("adds the PUBLISH permission action and the metric definition approval subject", async () => {
    const values = async (type: string) =>
      (await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"${type}"))::text AS v`)).map((r) => r.v);
    expect(await values("PermissionAction")).toContain("PUBLISH");
    expect(await values("ApprovalSubjectType")).toContain("PERFORMANCE_METRIC_DEFINITION");
  });
});

describe("field maps classify every stored column", () => {
  const columns = (model: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.fields.filter((f) => f.kind !== "object" && f.name !== "tenantId").map((f) => f.name);

  it("PerformanceMetricValue: every column is base (no sensitive set on a value)", () => {
    for (const column of columns("PerformanceMetricValue")) expect(PERFORMANCE_METRIC_VALUE_FIELD_MAP[column], `PerformanceMetricValue.${column}`).toBe("base");
  });

  it("MetricContextNote: the note's text is the opt-in coaching set", () => {
    for (const column of columns("MetricContextNote")) expect(Object.hasOwn(METRIC_CONTEXT_NOTE_FIELD_MAP, column), `MetricContextNote.${column}`).toBe(true);
    expect(METRIC_CONTEXT_NOTE_FIELD_MAP.body).toBe("coaching");
    expect(METRIC_CONTEXT_NOTE_FIELD_MAP.metricValueId).toBe("base");
  });
});
