// Metric definitions (versioned; DRAFT edits, new versions, retire) and the fixed kind catalog
export {
  createDefinition,
  createDefinitionVersion,
  updateDefinition,
  retireDefinition,
  listDefinitions,
  getDefinition,
  getMetricCatalog,
} from "./definitions";

// Publication through the approval engine (always an approval request; never "no policy, publish directly")
export { submitDefinition, withdrawDefinition, registerMetricDefinitionApprovalSubject, METRIC_DEFINITION_SUBJECT } from "./publication";

// Computation (append-only values with evidence) and the scoped read models
export { computeMetricValues, computeMetricValuesAsSystem } from "./compute";
export type { ComputedValuesSummary } from "./compute";
export { listMetricValues, getMetricValue, listEmployeeCurrentValues } from "./values";
// Self-service (`/api/v1/me/metrics/*`, own published values) and the peer read for the development dashboard
export { listOwnCurrentValues, getOwnMetricValue, listPeerCurrentValues } from "./values";
export type { PeerSeries, PeerValue } from "./values";

export {
  definitionIdParams,
  valueIdParams,
  employeeIdParams,
  createDefinitionSchema,
  createVersionSchema,
  updateDefinitionSchema,
  submitDefinitionSchema,
  reasonSchema,
  listDefinitionsQuerySchema,
  computeValuesSchema,
  listValuesQuerySchema,
  employeeValuesQuerySchema,
  DEFINITION_STATUSES,
} from "./schemas";
export type {
  CreateDefinitionInput,
  CreateVersionInput,
  UpdateDefinitionInput,
  SubmitDefinitionInput,
  ReasonInput,
  ListDefinitionsQuery,
  ComputeValuesInput,
  ListValuesQuery,
  EmployeeValuesQuery,
} from "./schemas";

import { registerMetricDefinitionApprovalSubject } from "./publication";

// Loading the module plugs PERFORMANCE_METRIC_DEFINITION into the approval engine (idempotent).
registerMetricDefinitionApprovalSubject();
