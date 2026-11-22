# authz

RBAC + ABAC authorization engine (§4.2-4.6, §25.5, §26.3). Roles are tenant-owned bundles of catalog
permissions; data scopes (tenant, legal entity, org unit subtree, own, assigned) hang on role
*assignments*. Role names never grant access; only permissions + scopes do.
Full reference (every export and field-set rule): `docs/AUTHZ.md`; model: `docs/PERMISSIONS.md`.

Public API (`index.ts`):
- `can(subject, "module.action", resource?)` -> `{ allowed, reason, via, fieldSets }`. ALWAYS project records
  with `projectFields(record, decision, fieldMap)`; sensitive field sets (financial, billing) are opt-in.
- `requirePermission` / `requireTenantLevelPermission` — `defineRoute({ authorize })` gates; denials are audited
  (`recordAuthzDenial` is exported for web code that catches a refusal from a service).
- `enforceInTx(tx, actor, permission, resource?)` / `enforceOnUser` — the in-transaction gate services use
  (403 without the capability, 404 for a record outside scope). Silent: the caller audits.
- `scopeFilter` / `resolveScope` / `buildScopeWhere` / `projectRows` — list queries filtered and projected per row.
- `assignRole`, `revokeRoleAssignment`, `assertMayDefineGrants`, `assertMayDisableUser`, `assertNotHoldingRole`
  — anti-escalation and separation-of-duties rules for roles and lock-outs.
- `activePlacementWhere`, `openEndedWhere`, `liveOrFutureAssignmentWhere`, `activeAssignmentWhere` — the ONE
  definition of "in effect now" for placements, managers and role assignments. Never re-write these inline.
- `provisionRoleTemplates` (the 12 spec 4.4 roles), `explainAccess`, `listAuditEventsAsActor`.

Invariants:
- Every decision re-reads the database (no cache across requests). Active = not revoked, started, not
  expired, role active, user ACTIVE, employee not TERMINATED.
- A permission only combines with the scopes of its own assignment; forged cross-tenant ids never match.
- Resource attributes are loaded server-side by the caller's resolver, never taken from request bodies.
- `Role.requiresMfa`: Owner/CEO, Finance Director, HR Manager, COO (holds `permissions.assign`) and any
  role with `permissions.manage|assign` or `*.configure`; custom roles with any sensitive permission or
  sensitive field set too. Authentication enforces it; this module computes and exposes it.
- `AccessDecision.fieldSets` is only meaningful when `can` got the record; for lists use per-scope-part
  field sets (`projectRows`), never a union.
