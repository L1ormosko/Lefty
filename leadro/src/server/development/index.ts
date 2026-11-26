// Development plans (spec 10.4, 5.4, 5.8): plans, goals, actions, append-only reviews.
export { createPlan, updatePlan, activatePlan, completePlan, cancelPlan, getPlan, listPlans } from "./plans";
export { addGoal, updateGoal, addAction, updateAction, addReview } from "./plan-items";

// Training recommendations (spec 5.4, 28.6): deterministic rules, explicit runs, human decisions.
export {
  generateRecommendations,
  generateTrainingRecommendationsForTenant,
  generateAllTrainingRecommendations,
  acceptRecommendation,
  dismissRecommendation,
  getRecommendation,
  listRecommendations,
  SYSTEM_DISMISS_REASONS,
} from "./recommendations";
export type { GenerationResult } from "./recommendations";
export { RECOMMENDATION_REASON_CODES } from "./rules";
export type { RecommendationReason } from "./rules";
export { getDevelopmentThresholds, updateDevelopmentThresholds } from "./thresholds";
export type { DevelopmentThresholdsView } from "./thresholds";

export type { PlanView, PlanSummaryView, GoalView, ActionView, ReviewView, RecommendationView } from "./views";
export {
  idParams as developmentIdParams,
  planChildParams as developmentPlanChildParams,
  createPlanSchema,
  updatePlanSchema,
  cancelPlanSchema,
  emptyBodySchema as developmentEmptyBodySchema,
  listPlansQuerySchema,
  createGoalSchema,
  updateGoalSchema,
  createActionSchema,
  updateActionSchema,
  createReviewSchema,
  listRecommendationsQuerySchema,
  generateRecommendationsSchema,
  acceptRecommendationSchema,
  dismissRecommendationSchema,
  updateDevelopmentThresholdsSchema,
  DEVELOPMENT_PLAN_STATUSES,
  TRAINING_RECOMMENDATION_STATUSES,
} from "./schemas";
