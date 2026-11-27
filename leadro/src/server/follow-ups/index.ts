import { registerFollowUpNotificationTarget } from "./notify";

// Records
export { createFollowUp, createFollowUpTaskInTx } from "./create";
export type { CreatedFollowUpTask, FollowUpCaller, NewFollowUpTask, SystemCaller } from "./create";
export { getFollowUp, listFollowUps } from "./read";
export { updateFollowUp, assignFollowUp } from "./update";
export { changeFollowUpStatus, completeFollowUp, cancelFollowUp } from "./status";

// The overdue / due-soon sweep (no scheduler exists: a worker calls these)
export { sweepFollowUps, sweepAllFollowUps, DEFAULT_DUE_SOON_MINUTES } from "./sweep";
export type { FollowUpSweepResult } from "./sweep";

// Access helpers (route resolvers, notifications, other modules' tests)
export { followUpResourceRef, followUpResourceRefById, resolveFollowUpListAccess } from "./access";
export { registerFollowUpTargetAccess } from "./targets";
export type { FollowUpTargetAccess, FollowUpTargetFacts } from "./targets";
export { registerFollowUpNotificationTarget } from "./notify";

export {
  createFollowUpSchema,
  updateFollowUpSchema,
  assignFollowUpSchema,
  changeFollowUpStatusSchema,
  completeFollowUpSchema,
  cancelFollowUpSchema,
  listFollowUpsQuerySchema,
  followUpIdParams,
  FOLLOW_UP_TARGET_TYPES,
} from "./schemas";

// The notifications engine redacts a follow-up notification unless this resolver is registered; loading the module registers it.
registerFollowUpNotificationTarget();
