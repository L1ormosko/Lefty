# roles

Role administration, assignments and effective access (§4.2, §4.4, §4.6, §21.3). The decision engine is `authz`;
this module is the permission-checked administration around it.

Public API (`index.ts`):
- Roles: `createRole`, `cloneRole`, `updateRole`, `replaceRolePermissions`, `archiveRole`, `listRoles`, `getRole`,
  `getRoleHistory` (permission history from the audit trail, projected to `RoleHistoryEntry` in role-history.ts: no IP/user agent/raw values).
- Assignments: `grantRoleToUser` (-> authz `assignRole`), `revokeAssignment` (-> authz `revokeRoleAssignment`),
  `listRoleAssignments`, `getRoleAssignment`.
- `getEffectiveAccess(actor, { userId, permission?, employeeId?, orgUnitId? })` (+ authz `explainAccess` for "why").

Routes: `/api/v1/roles[/{id}[/permissions|/clone|/archive|/history]]`, `/roles/assignments[/{id}/revoke]`,
`/roles/effective-access`.

Rules enforced on every role write:
1. Nobody can put a permission into a role they do not hold themselves, field sets included (`assertMayDefineGrants`);
   removing a permission is always allowed.
2. Nobody can edit, re-permission or archive a role assigned to themselves (`assertNotHoldingRole`, §21.3) — not even
   the Owner.
3. Roles are tenant-level: they need a TENANT-scoped grant; a unit-scoped `permissions.view` holder gets an empty list.
4. `requiresMfa` is forced on for roles with `permissions.manage|assign` or `*.configure` (and the always-MFA
   templates) and cannot be lowered while it is mandatory.
5. A clone is an ordinary custom role (no template key), so template re-provisioning never confuses it with the original.
Editing a role that is already assigned additionally requires that the editor could grant each added permission in every live holder's scope (`assertMayGrantToExistingHolders`).
Assignments always carry explicit scopes; granting/revoking follows authz's anti-escalation rules (not to yourself, only
over scopes you administer, only roles whose permissions you hold). Nothing is deleted: archived roles and revoked or
expired assignments remain as history, and every change is audited (`role.*`, `role_assignment.*`).

`saveRoleDefinition(actor, ctx, roleId, { update, permissionKeys, reason })`: the admin screen's editor. Updates name/description/MFA and the permission set in ONE transaction, keeping the stored conditions of grants that stay selected. The `/api/v1/roles/{id}` and `/permissions` routes keep their explicit semantics (PATCH edits attributes; PUT-style `permissions` replaces the full grant list including conditions); only the screen uses the key-toggle variant.
