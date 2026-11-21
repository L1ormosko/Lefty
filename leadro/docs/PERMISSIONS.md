# Permissions (Phase 0)

Authority: `SPEC.md` 4.2-4.6, 25.5, 26.3. Code: `src/server/authz/permission-catalog.ts` (this
document must match it). Per ruling, the spec 4.5 matrix is the approved **default** matrix (spec
28.5) and stays configurable per tenant.

## 1. Model

- **Permission** = (module, action), key `module.action`. Global catalog, seeded, not tenant data.
- **Role** = tenant-owned bundle of permissions (`RolePermission`, optional `conditions` JSON for
  qualified grants). Roles are configurable templates, not fixed identities (spec 4.4). **Role
  names and `templateKey` never determine access**; only granted permissions + scopes do.
- **RoleAssignment** = user holds a role, with `effectiveFrom/effectiveTo` (temporary access),
  `grantedBy`, `revokedAt`. Inactive when revoked, not yet effective or expired.
- **AccessScope** (1..n per assignment) = which records the grant applies to.
- **Effective access** = union over the user's *active* assignments of (permission, scope). A
  request is allowed only if some active assignment grants the permission **and** the target
  record falls inside a scope of that same assignment. Evaluated on every request (spec 25.5).
- Tenant isolation is orthogonal and always applies, even to "Full" (spec 4.5 footnote).
- Separation of duties: APPROVE/REJECT on one's own submitted change is refused where the module
  requires it (spec 21.3).
- Sensitive permissions (`*` below) may require extra approval or MFA (`Role.requiresMfa`).

## 2. Action semantics (spec 4.3)

VIEW read | CREATE add | EDIT change | ARCHIVE soft-remove (no hard delete) | ASSIGN allocate to a
person/unit | APPROVE / REJECT decide an approval | EXPORT bulk data out (audited) | MANAGE
administer the module's structure/lifecycle | CONFIGURE change module settings/policies.

## 3. Catalog

`*` = sensitive.

| Module | Actions |
|---|---|
| `company_settings` | view, edit, configure* |
| `organization` | view, create, edit, archive, assign, manage |
| `users` | view, create, edit, archive, manage* |
| `employees` | view, create, edit, archive, assign, export* |
| `permissions` | view, create, edit, archive, assign*, approve, manage* |
| `audit` | view, export* |
| `localization` | view, edit, configure |
| `customers` | view, create, edit, archive, export |
| `leads` | view, create, edit, archive, assign, export |
| `dispatch` | view, create, edit, assign, manage |
| `jobs` | view, create, edit, archive, assign, approve, reject, export |
| `compensation` | view*, create, edit, approve*, reject, export, configure* |
| `financial_reports` | view*, export* |
| `performance` | view, export |

Matrix modules map as: Company settings -> `company_settings`; Organization -> `organization`;
Employees -> `employees`; Customers -> `customers`; Leads -> `leads`; Dispatch -> `dispatch`;
Jobs -> `jobs`; Compensation -> `compensation`; Financial reports -> `financial_reports`;
Performance -> `performance`; Permissions -> `permissions`. `users`, `audit`, `localization` are
platform modules not in the 4.5 table (see section 5).

## 4. Scopes (ABAC)

| ScopeType | Meaning | Resolution |
|---|---|---|
| `TENANT` | All records of the tenant | no extra filter (RLS still applies) |
| `LEGAL_ENTITY` | Records of one legal entity | entity = the target's legal entity (employees: legal employer; org-owned records: via the unit's `legalEntityId`) |
| `ORG_UNIT` | An org unit, **including descendants** when `includeDescendants` (default) | target's org unit (or employee's current `PRIMARY`/active assignments) is the scope unit or a descendant (recursive CTE on `OrgUnit.parentId`) |
| `OWN` | Only the caller's own records | target belongs to the caller's `Employee` (profile, shifts, own statements, own performance) |
| `ASSIGNED` | Only records explicitly assigned to the caller | target has an active assignment row to the caller's employee (jobs, customers via job) |

Rules:

1. Scope target must match type (DB CHECK): `LEGAL_ENTITY` needs `legalEntityId`; `ORG_UNIT` needs
   `orgUnitId`; the rest carry neither.
2. Multiple scopes on one assignment are a union. Scopes of different assignments never combine
   with another assignment's permissions.
3. An employee in several units (e.g. a temporary assignment) is in scope if **any active
   assignment** is in scope. Historical reports use the assignment active on the report date
   (spec 3.4).
4. Org-unit scope follows the tree as it is *now* for access decisions; reports use dated
   assignments.
5. Finance access does not imply operational management: `compensation`/`financial_reports` grants
   carry no `jobs.edit`, `dispatch.*`, or `organization.*` (spec 4.4).
6. List endpoints apply the scope as a query filter (never fetch-then-filter); single-record
   endpoints return 404 for out-of-scope records to avoid leaking existence.
7. "Why can this user access this record?" (spec 4.6): the diagnostic returns the matching
   assignment, role, permission and scope (or the reason none matches).

## 5. Default role templates and the 4.5 matrix mapping

Cell vocabulary from the spec -> grants:

- **Full** = every action of the module, scope `TENANT`.
- **View** = `view` only, scope `TENANT`.
- **Scoped** = view/create/edit (+ assign where the module has it), scope `ORG_UNIT` (with
  descendants) set per assignment (state manager -> state unit, city manager -> city unit).
- **Limited** = a named subset, see notes.
- **Own** / **Assigned** = `view` (+ the execution actions named), scope `OWN` / `ASSIGNED`.
- **qualifier** (e.g. "Financial fields", "Job-related") = `view` with `RolePermission.conditions`
  restricting fields or the related record set.
- **No** = no grant.

| Module | CEO | COO | Finance | State Mgr | City Mgr | Dispatcher | Lead Ops | Technician |
|---|---|---|---|---|---|---|---|---|
| Company settings | `company_settings.*` T | view, edit (no configure) T | - | - | - | - | - | - |
| Organization | `organization.*` T | view T | - | view, edit, assign, create ORG_UNIT | same, narrower unit | - | - | - |
| Employees | `employees.*` T | view, create, edit, assign ORG_UNIT | view, cond `{fields:"financial"}` T | view, create, edit, assign ORG_UNIT | same | view, cond `{fields:"availability"}` ORG_UNIT | view, assign cond `{set:"lead_team"}` | view OWN |
| Customers | `customers.*` T | view, create, edit ORG_UNIT/T | view cond `{fields:"billing"}` T | view, create, edit ORG_UNIT | same | view cond `{set:"job_related"}` | view, create, edit cond `{set:"lead_related"}` | view ASSIGNED (necessary fields) |
| Leads | `leads.*` T | view T | - | view, create, edit, assign ORG_UNIT | same | view cond `{set:"dispatch_related"}` | `leads.*` (non-archive) T | view, edit status ASSIGNED |
| Dispatch | `dispatch.*` T | `dispatch.*` T | - | view, create, edit, assign ORG_UNIT | same | `dispatch.*` T | view (limited) ORG_UNIT | view OWN |
| Jobs | `jobs.*` T | `jobs.*` T | view cond `{fields:"financial"}` T | view, create, edit, assign ORG_UNIT | same | view, create, edit, assign (operational fields) T | view cond `{set:"recovery_related"}` | view, edit (execution) ASSIGNED |
| Compensation | `compensation.*` T | view T | `compensation.*` T | configurable (default view ORG_UNIT) | view (limited) ORG_UNIT | - | - | view OWN (own statements) |
| Financial reports | view, export T | view T | view, export T | view ORG_UNIT | view (limited) ORG_UNIT | - | - | view OWN (own summary) |
| Performance | view, export T | view T | - | view ORG_UNIT | view ORG_UNIT | - | view cond `{set:"lead_team"}` | view OWN |
| Permissions | `permissions.*` T | view, assign (limited, non-sensitive roles) | - | - | - | - | - | - |

T = scope `TENANT`. "Limited" is deliberately narrower than "Scoped" and is expressed as a smaller
action subset and/or a `conditions` qualifier; the exact condition vocabulary is finalised with the
modules that consume it (Phase 2/3) and is recorded then.

Additional 4.4 role templates not in the 4.5 table are derived by analogy and flagged for
confirmation in `DECISIONS.md`:

| Template | Derived from | Scope |
|---|---|---|
| Regional Manager | State Manager | ORG_UNIT (region) |
| Team Leader | City Manager, read-mostly | ORG_UNIT (team) |
| Customer Relations | Customers scoped + leads view | ORG_UNIT |
| HR Manager | employees.* (incl. training/cert records later), no financial fields | TENANT |

Platform modules (not in 4.5): `users` and `audit` follow `permissions`/`company_settings`
(CEO full; others none by default); `localization` view for everyone, edit/configure for CEO.

## 6. Administration (spec 4.6) - planned behaviour

Create/clone roles, assign permissions, define scope, set temporary access (`effectiveTo`), revoke
(`revokedAt`, never delete), review effective access, permission history (via `AuditEvent` on
`permissions.*` actions), and the "why can this user access this record" diagnostic. Role/scope
changes are audited with previous and new values; they may require approval (spec 21.3).

## 7. Testing obligations (spec 26.3)

Every module ships: permission tests (each role template x allowed/denied action), scope tests
(in-scope, out-of-scope, descendant, temporary assignment, expired/revoked), and tenant-isolation
tests for any tenant data it touches.
