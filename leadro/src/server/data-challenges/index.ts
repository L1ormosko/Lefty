// Employee challenges of their own data (spec 10.4, 5.8 "employee-submitted corrections", 5.11 self-service).
export { raiseDataChallenge, withdrawDataChallenge } from "./raise";
export { assignDataChallengeReviewer, upholdDataChallenge, rejectDataChallenge } from "./review";
export { getDataChallenge, listDataChallenges, toDataChallengeView } from "./read";
export type { DataChallengeView } from "./read";
// Self-service (`/api/v1/me/data-challenges/*`): the caller's own challenges (no module permission).
export { listOwnDataChallenges, getOwnDataChallenge, ownDataChallengesQuerySchema } from "./self-service";
export type { OwnDataChallengesQuery } from "./self-service";
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
