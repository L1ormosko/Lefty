import { withTenant } from "@/server/db";

/**
 * Rows the coaching and data-challenge tests need from modules built in parallel (performance, training). They are inserted
 * directly, the way those modules' services would store them, so these tests do not depend on their APIs.
 */

const unique = (label: string) => `${label}_${Math.random().toString(36).slice(2, 8)}`;

/** A TRAINING_PROGRESS value (no job breakdown) of `employeeId`; its definition is PUBLISHED unless `published: false`. */
export async function createMetricValue(
  tenantId: string,
  employeeId: string,
  authorUserId: string,
  options: { published?: boolean } = {},
): Promise<{ id: string; definitionId: string }> {
  return withTenant(tenantId, async (tx) => {
    let approvalRequestId: string | null = null;
    if (options.published !== false) {
      const policy = await tx.approvalPolicy.create({
        data: {
          tenantId,
          code: unique("metric_publication"),
          subjectType: "PERFORMANCE_METRIC_DEFINITION",
          name: "Metric publication",
          approverPermission: "performance.publish",
          createdById: authorUserId,
        },
      });
      const request = await tx.approvalRequest.create({
        data: {
          tenantId,
          subjectType: "PERFORMANCE_METRIC_DEFINITION",
          subjectId: unique("pending"),
          policyId: policy.id,
          policyCode: policy.code,
          policyVersion: 1,
          requiredApprovals: 1,
          approverPermission: "performance.publish",
          requestedById: authorUserId,
        },
      });
      approvalRequestId = request.id;
    }
    const definition = await tx.performanceMetricDefinition.create({
      data: {
        tenantId,
        key: unique("training_progress"),
        kind: "TRAINING_PROGRESS",
        dimension: "TRAINING_PROGRESS",
        name: "Training progress",
        minSample: 1,
        createdById: authorUserId,
        ...(approvalRequestId ? { status: "PUBLISHED", approvalRequestId, submittedAt: new Date(), publishedAt: new Date() } : {}),
      },
    });
    const value = await tx.performanceMetricValue.create({
      data: {
        tenantId,
        definitionId: definition.id,
        employeeId,
        periodStart: new Date("2026-03-01"),
        periodEnd: new Date("2026-04-01"),
        numerator: 1,
        denominator: 2,
        sampleSize: 2,
        enoughData: true,
        evidenceIds: ["a1", "a2"],
        systemActor: "system:performance",
      },
    });
    return { id: value.id, definitionId: definition.id };
  });
}

/** A pending training record of `employeeId` for a fresh course. */
export async function createTrainingRecord(tenantId: string, employeeId: string, recordedByUserId: string): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const course = await tx.trainingCourse.create({ data: { tenantId, code: unique("course").toLowerCase(), name: "Safety basics", createdById: recordedByUserId } });
    return tx.trainingRecord.create({
      data: { tenantId, employeeId, courseId: course.id, completedAt: new Date("2026-03-01T15:00:00Z"), recordedById: recordedByUserId },
      select: { id: true },
    });
  });
}

/** A pending skill qualification of `employeeId`. */
export async function createQualificationRecord(tenantId: string, employeeId: string): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const skill = await tx.skill.create({ data: { tenantId, code: unique("skill").toLowerCase(), name: "Brazing" } });
    return tx.employeeQualification.create({ data: { tenantId, employeeId, kind: "SKILL", skillId: skill.id, level: 3 }, select: { id: true } });
  });
}
