import { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { developmentThresholdSchema, type DevelopmentThreshold, type UpdateDevelopmentThresholdsInput } from "./schemas";

/**
 * The tenant's development thresholds (rule "metric below threshold" of the training recommendations). Stored on
 * `OperationsSettings.developmentThresholds` next to `qualificationWarningDays`; null or `[]` = the rule is disabled
 * (the default). Development use only (spec 10.3): a threshold can only produce a recommendation that a person accepts or
 * dismisses; nothing reads it for dispatch, eligibility, pay or employment.
 *
 * Reading needs `training.view` (any scope: tenant reference data, like the course catalog); changing it needs
 * `training.manage` at TENANT scope.
 */

/**
 * Kinds where a LOW value is good, so "below a threshold" cannot mean "needs development". REPEAT_VISIT_RATE counts
 * visits followed by a repeat job: fewer is better.
 */
const LOWER_IS_BETTER_KINDS = new Set(["REPEAT_VISIT_RATE"]);

export const isLowerBetterKind = (kind: string): boolean => LOWER_IS_BETTER_KINDS.has(kind);

export interface DevelopmentThresholdsView {
  /** False when no threshold is configured: the rule produces nothing. */
  enabled: boolean;
  thresholds: DevelopmentThreshold[];
}

/** The configured thresholds; entries that no longer parse (hand-edited rows) are skipped rather than trusted. */
export async function loadDevelopmentThresholds(tx: TenantTx, tenantId: string): Promise<DevelopmentThreshold[]> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { developmentThresholds: true } });
  const stored = settings?.developmentThresholds;
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    const parsed = developmentThresholdSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const view = (thresholds: DevelopmentThreshold[]): DevelopmentThresholdsView => ({ enabled: thresholds.length > 0, thresholds });

/** `GET /training/recommendations/thresholds`. */
export async function getDevelopmentThresholds(actor: Actor): Promise<DevelopmentThresholdsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    return view(await loadDevelopmentThresholds(tx, actor.tenantId));
  });
}

/**
 * `PUT /training/recommendations/thresholds`: replaces the list (`[]` disables the rule). Each course must be active; a
 * metric key whose definitions measure something where lower is better (REPEAT_VISIT_RATE) is refused. A key without a
 * PUBLISHED definition yet is accepted: it applies once one is published.
 */
export async function updateDevelopmentThresholds(actor: Actor, ctx: RequestContext, input: UpdateDevelopmentThresholdsInput): Promise<DevelopmentThresholdsView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.manage", {});
    for (const [index, threshold] of input.thresholds.entries()) {
      const course = await tx.trainingCourse.findFirst({ where: { id: threshold.courseId, tenantId: actor.tenantId, active: true }, select: { id: true } });
      if (!course) throw new ValidationError({ message: "Unknown or archived course.", field: `thresholds.${index}.courseId` });
      const kinds = await tx.performanceMetricDefinition.findMany({ where: { tenantId: actor.tenantId, key: threshold.metricKey }, select: { kind: true }, distinct: ["kind"] });
      if (kinds.some((row) => isLowerBetterKind(row.kind))) {
        throw new ValidationError({ message: "A lower value of this metric is better; it cannot have a development threshold.", field: `thresholds.${index}.metricKey` });
      }
    }
    const previous = await loadDevelopmentThresholds(tx, actor.tenantId);
    // An empty list is stored as SQL NULL: one representation of "rule disabled".
    const stored = input.thresholds.length > 0 ? (input.thresholds as Prisma.InputJsonValue) : Prisma.DbNull;
    await tx.operationsSettings.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, developmentThresholds: stored, updatedById: actor.userId },
      update: { developmentThresholds: stored, updatedById: actor.userId },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_recommendation.thresholds_update",
      targetType: "OperationsSettings",
      targetId: actor.tenantId,
      previousValue: { thresholds: previous },
      newValue: { thresholds: input.thresholds },
    });
    return view(input.thresholds);
  });
}
