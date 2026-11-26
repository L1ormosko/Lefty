// Employee challenges of their own data (spec 10.4, 5.8 "employee-submitted corrections", 5.11 self-service).
export { raiseDataChallenge, withdrawDataChallenge } from "./raise";
export { assignDataChallengeReviewer, upholdDataChallenge, rejectDataChallenge } from "./review";
export { getDataChallenge, listDataChallenges, toDataChallengeView } from "./read";
export type { DataChallengeView } from "./read";
export { CORRECTION_PATH } from "./targets";

// Notification wiring (also registered at load); called from `src/server/notification-targets.ts`.
export { registerDataChallengeNotificationTarget } from "./notify";

export {
  DATA_CHALLENGE_TARGET_TYPES,
  raiseDataChallengeSchema,
  assignDataChallengeSchema,
  upholdDataChallengeSchema,
  rejectDataChallengeSchema,
  listDataChallengesQuerySchema,
} from "./schemas";
export type {
  DataChallengeTargetTypeName,
  RaiseDataChallengeInput,
  AssignDataChallengeInput,
  UpholdDataChallengeInput,
  RejectDataChallengeInput,
  ListDataChallengesQuery,
} from "./schemas";
