# authz

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
- `Role.requiresMfa` marks Owner/CEO, Finance Director, HR Manager and any role with `permissions.manage|assign`
  or `*.configure`. Authentication enforces it; this module only stores/exposes it (`via.requiresMfa`).

Files: `permission-catalog.ts` (catalog + sensitive field sets), `role-templates.ts` (templates + MFA rule),
`evaluate.ts` (the single decision function), `load-grants.ts`, `resolve-resource.ts`, `org-tree.ts`,
`conditions.ts`. Rationale and deviations: `docs/DECISIONS.md` "Task 4"; model: `docs/PERMISSIONS.md`.
