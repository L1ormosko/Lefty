// Recovery rules (§9.6): versioned, approval for high-impact, dry run
export { createRule, updateRule, newRuleVersion, submitRule, activateRule, deactivateRule, getRule, listRules } from "./rules";
export { dryRunRule } from "./dry-run";

// The engine: subscribes to recorded outcomes (runs inside the outcome transaction, never throws)
export { handleOutcomeRecorded, registerRecoveryEngine } from "./engine";

// Cases (§9.3 - 9.7)
export { getCase, listCases, assignCase, changeCaseStatus, updateCase, recordAttempt, recoverCase, refreshPresence, recoverySummary } from "./cases";

// Access helpers (route resolvers, other modules)
export { caseResourceRef, caseResourceRefById, caseScopeColumns, ruleResourceRefById } from "./access";
export { CASE_FIELD_MAP } from "./fields";
export { registerRecoveryNotificationTarget } from "./notify";
export { registerRecoveryFollowUpTarget } from "./targets";

export {
  createRuleSchema,
  updateRuleSchema,
  ruleIdParams,
  caseIdParams,
  ruleDecisionSchema,
  listRulesQuerySchema,
  dryRunSchema,
  listCasesQuerySchema,
  assignCaseSchema,
  changeCaseStatusSchema,
  updateCaseSchema,
  recordAttemptSchema,
  recoverCaseSchema,
  summaryQuerySchema,
} from "./schemas";
export type { CreateRuleInput, UpdateRuleInput, ListRulesQuery, DryRunInput, ListCasesQuery, AssignCaseInput, ChangeCaseStatusInput, UpdateCaseInput, RecordAttemptInput, RecoverCaseInput } from "./schemas";

import { registerRecoveryEngine } from "./engine";
import { registerRecoveryNotificationTarget } from "./notify";
import { registerRecoveryFollowUpTarget } from "./targets";

// Loading the module wires it in: the follow-up target access, the notification resolver and the outcome subscription.
registerRecoveryFollowUpTarget();
registerRecoveryNotificationTarget();
registerRecoveryEngine();
