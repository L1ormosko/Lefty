# organization

Company profile, legal entities and the org tree (§3.1-3.3). Employees and their placement live in
`employees`; who may do what lives in `authz`.

Public API (`index.ts`):
- Company overview counts: `getCompanyOverview` (`company_settings.view`, tenant-level aggregates for the Company Overview screen).
- History: `listUnitChanges` (`organization.view`; structural changes of the units in scope from the audit trail, with who/why/previous+new parent).
- Tenant profile: `getTenantProfile`, `updateTenantProfile` (`company_settings.view|edit`, tenant-level).
- Legal entities: `createLegalEntity`, `updateLegalEntity`, `archiveLegalEntity`, `listLegalEntities`, `getLegalEntity`.
- Org units: `createOrgUnit`, `updateOrgUnit`, `moveOrgUnit`, `archiveOrgUnit`, `listOrgUnits`, `getOrgUnit`.
- Managers: `assignUnitManager`, `unassignUnitManager`, `listUnitManagers`.
- Zod schemas for the routes (`createOrgUnitSchema`, ...), `assertLegalEntityUsable` (used by employees).

Routes: `/api/v1/tenants/current`, `/api/v1/organization/legal-entities[/{id}[/archive]]`,
`/api/v1/organization/units[/{id}[/move|/archive|/managers[/{managerId}]]]`.

Invariants:
- Every write is ONE transaction: tree lock -> `enforceInTx` (permission + data scope) -> business-state
  validation -> write -> audit (`org_unit.create|update|move|archive|manager_assign|manager_unassign`,
  `legal_entity.*`, `tenant.update`, with changed fields only).
- Structural changes (create, update, move, archive) take a per-tenant advisory lock (`tree-lock.ts`), so two
  concurrent re-parents cannot both pass the cycle check (T1 review). The database trigger is the backstop.
- Move/create rules: the type must be allowed under the parent's type (`src/lib/org-hierarchy.ts`, DEFAULT and
  configurable), no cycle (checked against the live subtree, archived units included), no move/create under an
  archived unit, destination needs `organization.edit`/`create` as well, sibling names are unique.
- Archive is soft and refused while active children or current placements exist; it ends open manager rows.
  Archived units grant nothing (authz) from the next request.
- Managing a unit grants NO data access; scopes come only from role assignments.
- Lists are paginated, scoped IN the query (`withinScope`) and projected per row (`projectRows`).
- Legal entities are tenant-level: writes need a TENANT-scoped grant; reads a TENANT or LEGAL_ENTITY scope.
- Branch-only attributes (address, time zone, locale, hours) are rejected on other unit types.
