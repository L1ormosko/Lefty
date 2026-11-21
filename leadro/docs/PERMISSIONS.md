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
- **Active** means: assignment not revoked, `effectiveFrom <= now`, `effectiveTo` null or in the future,
  role `active`, user `ACTIVE`, and the linked employee (if any) not `TERMINATED`. Expired and revoked
  assignments are ignored. Every check re-reads the database; there is no cache across requests.
- **Engine API** (`src/server/authz`): `can`, `requirePermission`, `scopeFilter`, `canViewFields`,
  `explainAccess`, `assertNotSelfApproval`, `provisionRoleTemplates`, `assignRole`. See the module README.

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

### 3.1 Sensitive field categories

Field-level protection inside a module's records (spec 4.2 "sensitive data category"). Defined in code
as `SENSITIVE_FIELD_CATEGORIES`. Sensitive sets are **opt-in**: a plain grant (no conditions) reveals
the `base` (non-sensitive) fields only; a sensitive set is visible only to a grant that names it
(`includeFields` or `fields`). `can()` returns the permitted `fieldSets` (`base`, `financial`,
`availability`...) and routes MUST project records with `projectFields(record, decision, fieldMap)`.
`canViewFields` answers "may this subject see this category of this record". Only the Owner/CEO
(`includeFields`) and the Finance Director (`fields`) hold the financial/billing sets by default.

| Category | Module | Field set tag |
|---|---|---|
| `employees.financial_fields` | employees | `financial` |
| `customers.billing_fields` | customers | `billing` |
| `jobs.financial_fields` | jobs | `financial` |

### 3.2 Grant conditions (`RolePermission.conditions`)

| Key | Meaning |
|---|---|
| `fields: "x"` | The grant reveals only field set `x` (Finance: `financial`; Dispatcher: `availability`). |
| `includeFields: ["x"]` | The grant reveals the base fields plus these sensitive sets (Owner: `financial`, `billing`). |
| `set: "x"` | The grant covers only records of named set `x` (`job_related`, `lead_team`...). The caller states which sets a record belongs to; list filters ignore the grant unless the caller passes `satisfiedSets`. |

Unknown keys make the grant unusable (fail closed). A `fields`-limited grant still returns
`allowed: true` for its action, with only its own `fieldSets`: the response must be projected.

## 4. Scopes (ABAC)

| ScopeType | Meaning | Resolution |
|---|---|---|
| `TENANT` | All records of the tenant | no extra filter (RLS still applies) |
| `LEGAL_ENTITY` | Records of one legal entity | entity = the target's legal entity (employees: legal employer; org-owned records: via the unit's `legalEntityId`) |
| `ORG_UNIT` | An org unit, **including descendants** when `includeDescendants` (default) | target's org unit (or employee's current `PRIMARY`/active assignments) is the scope unit or a descendant (recursive CTE on `OrgUnit.parentId`) |
| `OWN` | Only the caller's own records | target belongs to the caller's `Employee` (profile, shifts, own statements, own performance) |
| `ASSIGNED` | Only records explicitly assigned to the caller | target has an active assignment row to the caller's employee (jobs, customers via job) |

Rules:

0. **Scopes belong to the role assignment**, so every permission of a role uses the assignment's scopes
   (see section 5 and DECISIONS.md "Task 4"). A record with no org placement (audit log, company settings)
   is "tenant-level": only `TENANT` scopes match it. Ids of employees, units and legal entities are
   verified to exist in the caller's tenant before matching, so forged cross-tenant ids never match.
   Archived units (and everything beneath them) grant nothing.

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
| Financial reports | view, export T | view T | view, export T | view ORG_UNIT | view (limited) ORG_UNIT | - | - | - (self-service, not the module permission) |
| Performance | view, export T | view T | - | view ORG_UNIT | view ORG_UNIT | - | view cond `{set:"lead_team"}` | view OWN |
| Permissions | `permissions.*` T | view, assign (limited, non-sensitive roles) | - | - | - | - | - | - |

T = scope `TENANT`. "Limited" is deliberately narrower than "Scoped" and is expressed as a smaller
action subset and/or a `conditions` qualifier; the exact condition vocabulary is finalised with the
modules that consume it (Phase 2/3) and is recorded then.

**Scope per template.** Because scopes live on the assignment, a template carries
`suggestedScopeTypes`: Owner/CEO, COO, Finance, HR -> `TENANT`; State/Regional/City Manager, Team Leader,
Dispatcher, Lead Ops, Customer Relations -> `ORG_UNIT` (Dispatcher and Lead Ops are narrower than the
matrix's "Full scope"; assign `TENANT` when a company wants that); Technician -> `OWN` + `ASSIGNED`.
Technician-specific qualifiers use `fields` (`necessary`, `status`, `execution`); the COO's
`permissions.assign` carries `{ set: "non_sensitive_roles" }`, to be enforced by the permissions module.

**MFA.** `Role.requiresMfa = true` for the Owner/CEO, Finance Director and HR Manager templates and for
any role holding `permissions.manage`, `permissions.assign` or a `*.configure` permission (this makes the
COO template MFA-required too). Authentication enforces it at login; the authz engine exposes it as
`via.requiresMfa`.

**Granting roles (anti-escalation).** `assignRole(tx, actor, input)` is the only request-path way to
grant a role. The actor must not be the target, must hold `permissions.assign` over scopes covering
every scope granted (a `non_sensitive_roles`-qualified grant, as the COO's, never covers a role that
`requiresMfa` or contains a sensitive permission), and must hold EVERY permission of the role over
those scopes, including its field sets (sensitive sets must be held explicitly). Seeds and tenant
bootstrap use the actor-less `bootstrapRoleAssignment`.

**Technician.** No `financial_reports` permission: own statements and summary are self-service
through `compensation.view` with `OWN` scope, not the module permission (the matrix cell "own
summary" is delivered by the future self-service endpoint).

**Diagnostics.** `explainAccess(actor, targetUserId, permission, resource?)` requires the actor to
hold `permissions.view` (403) and the target user/record to be inside the actor's scope (404).

**Duplicate assignments.** `assignRole` rejects a second active assignment of the same (user, role,
scope) over an overlapping period (service check with an advisory lock; not expressible as a DB
constraint because scopes are a child table).

Additional 4.4 role templates not in the 4.5 table are derived by analogy and flagged for
confirmation in `DECISIONS.md`:

| Template | Derived from | Scope |
|---|---|---|
| Regional Manager | State Manager | ORG_UNIT (region) |
| Team Leader | City Manager, read-mostly | ORG_UNIT (team) |
| Customer Relations | Customers scoped + leads view | ORG_UNIT |
| HR Manager | employees.* (incl. training/cert records later), base fields only (financial fields are opt-in) | TENANT |

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
