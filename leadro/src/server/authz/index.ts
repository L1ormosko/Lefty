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
export { requirePermission } from "./require-permission";
export type { ResourceResolver } from "./require-permission";
export { scopeFilter, scopeFilterInTx, resolveScope, buildScopeWhere, withinScope } from "./scope-filter";
export type { ScopeColumns, ScopeOptions, ResolvedScope } from "./scope-filter";
export { employeeScopeColumns, orgUnitScopeColumns } from "./scope-columns";
export { projectFields } from "./project-fields";
export type { FieldMap } from "./project-fields";
export { explainAccess } from "./explain-access";
export type { AccessExplanation, AssignmentExplanation, ScopeExplanation } from "./explain-access";
export { assertNotSelfApproval } from "./separation-of-duties";
export { listAuditEventsAsActor } from "./audit-access";

export { ROLE_TEMPLATES, templateRequiresMfa, isMfaTriggeringPermission } from "./role-templates";
export type { RoleTemplate, TemplateGrant } from "./role-templates";
export { provisionRoleTemplates, syncPermissionCatalog } from "./provision-role-templates";
export { bootstrapRoleAssignment } from "./assign-role";
export { assignRole } from "./assign-role-as-actor";
export type { ActorAssignRoleInput } from "./assign-role-as-actor";
export type { AssignRoleInput, ScopeInput } from "./assign-role";
