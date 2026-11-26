import type { DevelopmentAction, DevelopmentGoal, DevelopmentPlan, DevelopmentPlanReview, TrainingRecommendation } from "@prisma/client";
import { isoDateOf } from "./access";
import type { RecommendationReason } from "./rules";

/**
 * API shapes of the development module. Explicit mappers (not "return the row") so a column added later stays hidden
 * until someone decides it belongs in the API. Calendar dates are `YYYY-MM-DD`, timestamps ISO datetimes, statuses
 * language-neutral codes (clients label them with `DEVELOPMENT.*` / `TRAINING.RECOMMENDATION_*` keys).
 */

const instantOf = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toPlanSummaryView(row: DevelopmentPlan) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    ownerId: row.ownerId,
    title: row.title,
    summary: row.summary,
    status: row.status,
    periodStart: isoDateOf(row.periodStart),
    periodEnd: isoDateOf(row.periodEnd),
    createdById: row.createdById,
    activatedAt: instantOf(row.activatedAt),
    completedAt: instantOf(row.completedAt),
    cancelledAt: instantOf(row.cancelledAt),
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type PlanSummaryView = ReturnType<typeof toPlanSummaryView>;

export function toGoalView(row: DevelopmentGoal) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    targetDate: isoDateOf(row.targetDate),
    metricDefinitionId: row.metricDefinitionId,
    position: row.position,
    achievedAt: instantOf(row.achievedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type GoalView = ReturnType<typeof toGoalView>;

export function toActionView(row: DevelopmentAction) {
  return {
    id: row.id,
    goalId: row.goalId,
    kind: row.kind,
    description: row.description,
    status: row.status,
    dueDate: isoDateOf(row.dueDate),
    trainingAssignmentId: row.trainingAssignmentId,
    coachingRecordId: row.coachingRecordId,
    completedAt: instantOf(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type ActionView = ReturnType<typeof toActionView>;

export function toReviewView(row: DevelopmentPlanReview) {
  return { id: row.id, reviewerId: row.reviewerId, planStatus: row.planStatus, body: row.body, reviewedAt: row.reviewedAt.toISOString() };
}
export type ReviewView = ReturnType<typeof toReviewView>;

export interface PlanView extends PlanSummaryView {
  goals: GoalView[];
  actions: ActionView[];
  /** Oldest first (the history reads top to bottom). */
  reviews: ReviewView[];
}

export function toPlanView(
  row: DevelopmentPlan & { goals: DevelopmentGoal[]; actions: DevelopmentAction[]; reviews: DevelopmentPlanReview[] },
): PlanView {
  return {
    ...toPlanSummaryView(row),
    goals: row.goals.map(toGoalView),
    actions: row.actions.map(toActionView),
    reviews: row.reviews.map(toReviewView),
  };
}

export function toRecommendationView(row: TrainingRecommendation & { assignments: Array<{ id: string }> }) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    courseId: row.courseId,
    /** Every reason the rules found, as codes + ids / numbers (clients label them `TRAINING.RECOMMENDATION_REASON.<code>`). */
    reasons: row.reasons as unknown as RecommendationReason[],
    status: row.status,
    /** Null = produced by a system run. */
    generatedById: row.generatedById,
    generatedAt: row.generatedAt.toISOString(),
    decidedById: row.decidedById,
    decidedAt: instantOf(row.decidedAt),
    dismissReason: row.dismissReason,
    /** True when the rules dismissed it because no reason holds any more (or the course was assigned another way). */
    dismissedBySystem: row.status === "DISMISSED" && row.decidedById === null,
    /** The assignment created on acceptance. */
    trainingAssignmentId: row.assignments[0]?.id ?? null,
  };
}
export type RecommendationView = ReturnType<typeof toRecommendationView>;
