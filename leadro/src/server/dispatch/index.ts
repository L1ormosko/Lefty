// Mode (MANUAL / AI_ASSISTED; the others are refused in this phase)
export { getDispatchSettings, updateDispatchSettings, loadDispatchMode } from "./settings";
export type { DispatchSettingsView } from "./settings";

// Recommendations: generate, read, eligibility overview
export { generateRecommendation, getRecommendation, listRecommendations, getEligibilityOverview } from "./recommend";
export type { EligibilityOverview } from "./recommend";

// The dispatcher's decisions
export { approveRecommendation, modifyRecommendation, rejectRecommendation } from "./decide";

export type { RecommendationView, BlockingReasons } from "./views";
export { DISTANCE_BASIS } from "./views";

export {
  DISPATCH_MODES,
  AVAILABLE_DISPATCH_MODES,
  jobIdParams,
  recommendationIdParams,
  updateDispatchSettingsSchema,
  listRecommendationsQuerySchema,
  approveRecommendationSchema,
  rejectRecommendationSchema,
  modifyRecommendationSchema,
} from "./schemas";
