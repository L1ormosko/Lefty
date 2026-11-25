// Subject modules: plug a subject type in, then open / withdraw requests inside their own transaction
export { registerApprovalSubject, approvalSubjectHandler, unregisterApprovalSubject } from "./registry";
export type { ApprovalSubjectHandler, ApprovalOutcomeEvent, ApprovalOutcome } from "./registry";
export { createApprovalRequestInTx, cancelApprovalForSubjectInTx, findPendingApprovalForSubjectInTx } from "./requests";
export type { CreateApprovalRequestInput, CreateApprovalRequestResult } from "./requests";
export { resolveApprovalPolicyInTx } from "./policies";

// People: the approvals API
export { getApprovalRequest, listApprovalQueue, listMyApprovalRequests, listApprovalRequests } from "./read";
export { decideApprovalRequest, cancelApprovalRequest } from "./decide";
export { listPolicies, createPolicy, deactivatePolicy } from "./policies";

// Worker entry points (no scheduler yet)
export { expireApprovalRequest, expireDueApprovalRequests, expireDueApprovalRequestsForAllTenants } from "./expiry";

// Wiring
export { registerApprovalNotificationTarget } from "./notify";
export { approvalRequestResourceRefById } from "./access";
export type { ApprovalRequestRow, ApprovalPolicyRow } from "./fields";

export {
  approvalIdParams,
  decideApprovalSchema,
  cancelApprovalSchema,
  approvalQueueQuerySchema,
  myApprovalsQuerySchema,
  listApprovalsQuerySchema,
  createPolicySchema,
  listPoliciesQuerySchema,
  deactivatePolicySchema,
} from "./schemas";
export type {
  DecideApprovalInput,
  CancelApprovalInput,
  ApprovalQueueQuery,
  MyApprovalsQuery,
  ListApprovalsQuery,
  CreatePolicyInput,
  ListPoliciesQuery,
  DeactivatePolicyInput,
} from "./schemas";

import { registerApprovalNotificationTarget } from "./notify";

// Loading the module registers the notification target (idempotent).
registerApprovalNotificationTarget();
