export { createRole, cloneRole, updateRole, replaceRolePermissions, saveRoleDefinition, archiveRole } from "./roles";
export { listRoles, getRole } from "./role-queries";
export { getRoleHistory, type RoleHistoryEntry, type RoleChangeSummary } from "./role-history";
export { grantRoleToUser, revokeAssignment, listRoleAssignments, getRoleAssignment } from "./role-assignments";
export type { AssignmentState } from "./role-assignments";
export { getEffectiveAccess } from "./effective-access";
export type { EffectiveAccess } from "./effective-access";
export {
  createRoleSchema,
  cloneRoleSchema,
  updateRoleSchema,
  replacePermissionsSchema,
  archiveRoleSchema,
  listRolesQuerySchema,
  grantRoleSchema,
  revokeAssignmentSchema,
  listAssignmentsQuerySchema,
  effectiveAccessQuerySchema,
} from "./schemas";
