// Catalog
export { listMaterials, getMaterial, createMaterial, updateMaterial, archiveMaterial } from "./catalog";

// Versioned costs (propose -> approval engine when a policy applies -> effective on its date)
export { proposeCostVersion, withdrawCostVersion, listCostVersions, MATERIAL_COST_SUBJECT, costApprovalKey } from "./cost-versions";
export type { ProposedCost } from "./cost-versions";

// Job material costing (frozen snapshot of the version in effect at usage time) and direct material cost per job
export { costMaterialUsage, costJobMaterials, getJobMaterialCost, materialUsageJobResourceRef } from "./job-costing";
export type { CostingResult, CostingSkipCode } from "./job-costing";

// Wiring
export { registerMaterialCostApprovalSubject } from "./approval-subject";
export { MATERIAL_FIELD_MAP, COST_FIELD_SET } from "./fields";

export {
  materialIdParams,
  costVersionParams,
  jobIdParams,
  usageIdParams,
  createMaterialSchema,
  updateMaterialSchema,
  archiveMaterialSchema,
  listMaterialsQuerySchema,
  proposeCostSchema,
  withdrawCostSchema,
  listCostVersionsQuerySchema,
  costUsageSchema,
  costJobMaterialsSchema,
  MATERIAL_COST_STATUSES,
} from "./schemas";
export type {
  CreateMaterialInput,
  UpdateMaterialInput,
  ArchiveMaterialInput,
  ListMaterialsQuery,
  ProposeCostInput,
  WithdrawCostInput,
  ListCostVersionsQuery,
  CostUsageInput,
} from "./schemas";

import { registerMaterialCostApprovalSubject } from "./approval-subject";

// Loading the module plugs MATERIAL_COST_CHANGE into the approval engine (idempotent).
registerMaterialCostApprovalSubject();
