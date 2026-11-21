# (app)/admin — administration screens (spec §3.4, §4, §16.6)

Server-rendered pages under `/admin/*`. They contain no business rules: every read and write calls
the SAME service function the `/api/v1` routes call (organization, employees, users, roles, i18n,
authz) with the signed-in actor, so permission, data scope, validation and audit are decided there.

| Screen | Route | Services |
|---|---|---|
| Company overview | `/admin/company` | `getTenantProfile`, `updateTenantProfile`, `getCompanyOverview`, legal entities |
| Organization (tree, history) | `/admin/organization` | org units, managers, `listEmployeeAssignments`, audit |
| Branches | `/admin/organization/branches` | `listOrgUnits` (type BRANCH), `updateOrgUnit`, managers |
| Employees | `/admin/employees[/{id}]` | `listEmployees`, `getEmployee`, assignments, invitations |
| Users & invitations | `/admin/users` | `listUsers`, `deactivateUser`, `listInvitations` |
| Roles & access | `/admin/roles[/{id}]` | roles, assignments, `getEffectiveAccess`, `explainAccess` |
| Localization | `/admin/localization` | gated `*OverrideAsActor` functions |

## Conventions
- Every page starts with `requireFullSession()` and loads data through `loadForPage` (403 -> access-denied
  panel, 404 -> not found; a record outside the caller's scope is a 404, never a 403).
- Every server action is `runAdminAction(formData, { revalidate, run })` (`_lib/admin-action.ts`): it re-authenticates,
  parses with the service's own Zod schema, calls ONE service function and maps `AppError` codes to translated text.
  Buttons are hidden for users who lack a permission, but hiding is only a convenience: the action still fails on the server.
- Lists are cursor-paged by the services (`CursorPager`); filters live in the URL (`SearchForm`, plain GET).
- Fields come back already projected by the services (`projectRows` / `EMPLOYEE_FIELD_MAP`); pages render only what is present
  and show "Hidden" for fields the caller may not see.
- `ActionDialog` / `ConfirmActionButton` (client) wrap the shared `Dialog` / `ConfirmDialog` around a server action; fields are
  server-rendered with `AdminField` + `TextInput`/`Select` (the shared `Field` needs a render function, so it is client-only).
- All text is `t()`; keys live under `ADMIN.*` in all three catalogs.
