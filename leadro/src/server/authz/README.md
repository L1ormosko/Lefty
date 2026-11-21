# authz

RBAC + ABAC authorization engine (§4.2-4.6, §25.5, §26.3). Roles are tenant-owned bundles of catalog
permissions; data scopes (tenant, legal entity, org unit subtree, own, assigned) hang on role
*assignments*. Role names never grant access; only permissions + scopes do.

Public API (`index.ts`):
- `can(subject, "module.action", resource?)` -> `{ allowed, reason, via }`. No resource = capability check.
- `requirePermission(permission, resolver?)` -> function for `defineRoute({ authorize })`. No grant -> 403;
  out-of-scope / missing / cross-tenant record -> 404. Denials are audited.
- `scopeFilter(subject, permission, columns, { satisfiedSets? })` -> Prisma where-fragment (`{}` = tenant-wide,
  `{ OR: [] }` = nothing). `employeeScopeColumns` / `orgUnitScopeColumns` are ready-made column maps.
- `canViewFields(subject, "employees.financial_fields", resource?)` for sensitive field sets.
- `explainAccess(subject, permission, resource?)` -> "why can this user access this record?" diagnostic.
- `assertNotSelfApproval(actorId, subjectCreatedById)`; `listAuditEventsAsActor(actor, options)` (needs `audit.view`).
- `provisionRoleTemplates(tx, tenantId)` creates the 12 spec 4.4 roles (idempotent, never overwrites edits);
  `assignRole(tx, input)` grants a role with scopes, rejects duplicate (user, role, scope) periods, audits.

Invariants:
- Every decision re-reads the database (no cache across requests). Active = not revoked, started, not expired,
  role active, user ACTIVE, employee not TERMINATED.
- Org scopes expand over the org tree as of now; archived units (and their subtrees) grant nothing.
- A permission only combines with the scopes of its own assignment. Employee/org/legal-entity ids are verified
  to exist in the subject's tenant, so forged cross-tenant ids are never matched.
- Resource attributes must be loaded server-side by the caller's resolver, never taken from request bodies.
- `Role.requiresMfa` marks Owner/CEO, Finance Director, HR Manager and any role with `permissions.manage|assign`
  or `*.configure`. Authentication enforces it; this module only stores/exposes it (`via.requiresMfa`).

Files: `permission-catalog.ts` (catalog + sensitive field sets), `role-templates.ts` (templates + MFA rule),
`evaluate.ts` (the single decision function), `load-grants.ts`, `resolve-resource.ts`, `org-tree.ts`,
`conditions.ts`. Rationale and deviations: `docs/DECISIONS.md` "Task 4"; model: `docs/PERMISSIONS.md`.
