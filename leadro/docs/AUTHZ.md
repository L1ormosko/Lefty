# authz (detailed reference)

Full detail behind `src/server/authz/README.md`. Keep both in step.

RBAC + ABAC authorization engine (§4.2-4.6, §25.5, §26.3). Roles are tenant-owned bundles of catalog
permissions; data scopes (tenant, legal entity, org unit subtree, own, assigned) hang on role
*assignments*. Role names never grant access; only permissions + scopes do.

Public API (`index.ts`):
- `can(subject, "module.action", resource?)` -> `{ allowed, reason, via, fieldSets }`. No resource = capability check.
  `fieldSets` (`base`, `financial`, ...) say which fields are covered: ALWAYS project records with
  `projectFields(record, decision, fieldMap)`. Sensitive sets (financial, billing) are opt-in.
- `requirePermission(permission, resolver?)` -> function for `defineRoute({ authorize })`. Capability first (no grant -> 403),
  then `resolver(actor, input, tx)` (same tx; `null` = missing); any denial once a record is involved -> 404;
  denials are audited.
- `scopeFilter(subject, permission, columns, { satisfiedSets? })` -> Prisma where-fragment (`{}` = tenant-wide; otherwise
  `{ AND: [{ OR: parts }] }`; combine with the caller filter via `withinScope`, never by spreading;
  no coverage = a never-matching fragment). `employeeScopeColumns` / `orgUnitScopeColumns` are ready-made column maps.
- `canViewFields(subject, "employees.financial_fields", resource?)` for sensitive field sets.
- `explainAccess(actor, targetUserId, permission, resource?)` -> "why can this user access this record?"; needs
  `permissions.view`, target and record inside the actor's scope.
- `assertNotSelfApproval(actorId, subjectCreatedById)`; `listAuditEventsAsActor(actor, options)` (needs `audit.view`).
- Task 5 additions: `enforceInTx(tx, actor, permission, resource?)` (the in-transaction gate services use: 403 without the
  capability, 404 for a record outside scope, 403 for a tenant-level `{}` record) and `enforceOnUser` (users: always 404
  outside scope); `requireTenantLevelPermission(permission)` (route gate for company settings, roles, translations);
  `assertMayGrantRole` (the dry run of `assignRole`, also used by invitations); `revokeRoleAssignment(tx, actor, input)`
  (needs the same authority over the target and scopes as granting); `assertMayDefineGrants` (nobody puts a permission
  into a role they do not hold); `assertNotHoldingRole` (nobody edits a role assigned to themselves, §21.3);
  `holdsMfaRequiringRole` / `activeAssignmentWhere` (the single "active assignment" definition); `baseFieldMap`.
- `provisionRoleTemplates(tx, tenantId)` creates the 12 spec 4.4 roles (idempotent, never overwrites edits);
  `assignRole(tx, actor, input)` grants a role with anti-escalation checks (not self, holds `permissions.assign` over the
  scopes, holds every permission and field set of the role; `non_sensitive_roles` enforced), rejects duplicate
  (user, role, scope) periods, audits. `bootstrapRoleAssignment(tx, input)` is the actor-less variant for seeds/tests.

Invariants:
- Every decision re-reads the database (no cache across requests). Active = not revoked, started, not expired,
  role active, user ACTIVE, employee not TERMINATED.
- Org scopes expand over the org tree as of now; archived units (and their subtrees) grant nothing.
- A permission only combines with the scopes of its own assignment. Employee/org/legal-entity ids are verified
  to exist in the subject's tenant, so forged cross-tenant ids are never matched.
- Resource attributes must be loaded server-side by the caller's resolver, never taken from request bodies.
- `Role.requiresMfa` marks Owner/CEO, Finance Director, HR Manager, any role with `permissions.manage|assign`
  or `*.configure` (COO included) and custom roles with a sensitive grant. Authentication enforces it on every
  request; this module only stores/exposes it (`via.requiresMfa`).

Files: `permission-catalog.ts` (catalog + sensitive field sets), `role-templates.ts` (templates + MFA rule),
`evaluate.ts` (the single decision function), `load-grants.ts`, `resolve-resource.ts`, `org-tree.ts`,
`conditions.ts`. Rationale and deviations: `docs/DECISIONS.md` "Task 4"; model: `docs/PERMISSIONS.md`.

Field sets (read before returning records):
- `AccessDecision.fieldSets` is only meaningful when `can` was given the record (`resource`); a capability check
  (no resource) unions every scope and must not be used to project data.
- Lists: `resolveScope` keeps field sets PER scope part. Derive a row's fields with `fieldSetsForRow` /
  `projectRows(rows, scope, FIELD_MAP, attributesOf)` (`employeeScopeSelect` + `employeeRowAttributes` for employees),
  never by unioning `parts[].fieldSets`.
- `projectFields` requires an explicit field map (`EMPLOYEE_FIELD_MAP`, `CUSTOMER_FIELD_MAP` in `field-maps.ts`);
  unmapped fields are dropped, so a new column is hidden until classified.
- `assignRole` also requires the target user inside the granter's `permissions.assign` scope, and checks (scope AND
  field sets) together per held grant.

- `narrowScopeToFieldSet(scope, "base")`: keeps only the scope parts whose grant covers that field set (for read models exposing a whole field set, e.g. placement history); totals are rebuilt from the surviving parts.
