export {
  PERMISSION_CATALOG,
  PERMISSION_ACTIONS,
  SENSITIVE_FIELD_CATEGORIES,
  permissionKey,
  isPermissionKey,
} from "./permission-catalog";
export type { PermissionDef, PermissionActionName, FieldCategoryKey } from "./permission-catalog";

export type { AccessDecision, AccessReason, AccessSubject, AccessVia, ResourceRef } from "./types";
export type { GrantConditions } from "./conditions";

export { can, canInTx, canViewFields } from "./can";
export { enforceInTx, enforceOnUser } from "./enforce";
export { requirePermission, requireTenantLevelPermission } from "./require-permission";
export type { ResourceResolver } from "./require-permission";
export { recordAuthzDenial } from "./denial-audit";
export type { DenialContext } from "./denial-audit";
export {
  scopeFilter,
  scopeFilterInTx,
  resolveScope,
  buildScopeWhere,
  withinScope,
  fieldSetsForRow,
  narrowScopeToFieldSet,
  projectRows,
} from "./scope-filter";
export type { ScopeColumns, ScopeOptions, ResolvedScope, ScopePart, RowScopeAttributes } from "./scope-filter";
export { employeeScopeColumns, employeeScopeSelect, employeeRowAttributes, orgUnitScopeColumns } from "./scope-columns";
export { projectFields } from "./project-fields";
export { EMPLOYEE_FIELD_MAP, CUSTOMER_FIELD_MAP, LEAD_FIELD_MAP, JOB_FIELD_MAP, baseFieldMap } from "./field-maps";
export type { FieldMap } from "./project-fields";
export { explainAccess } from "./explain-access";
export type { AccessExplanation, AssignmentExplanation, ScopeExplanation } from "./explain-access";
export { assertNotSelfApproval, assertNotHoldingRole } from "./separation-of-duties";
export { listAuditEventsAsActor } from "./audit-access";

export { ROLE_TEMPLATES, templateRequiresMfa, customRoleRequiresMfa, isMfaTriggeringPermission } from "./role-templates";
export type { RoleTemplate, TemplateGrant } from "./role-templates";
export { provisionRoleTemplates, syncPermissionCatalog } from "./provision-role-templates";
export { bootstrapRoleAssignment } from "./assign-role";
export { assignRole, assertMayGrantRole } from "./assign-role-as-actor";
export type { ActorAssignRoleInput, GrantTarget } from "./assign-role-as-actor";
export { revokeRoleAssignment } from "./revoke-role-assignment";
export type { RevokeRoleAssignmentInput } from "./revoke-role-assignment";
export { assertMayDisableUser } from "./disable-user";
export { assertMayDefineGrants, assertMayGrantToExistingHolders } from "./define-grants";
export type { RoleGrantDefinition } from "./define-grants";
export { activePlacementWhere, openEndedWhere, liveOrFutureAssignmentWhere } from "./time-windows";
export { activeAssignmentWhere, holdsMfaRequiringRole } from "./active-assignments";
export type { AssignRoleInput, ScopeInput } from "./assign-role";
