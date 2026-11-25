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
| `customers` | view, create, edit, archive, export, manage (duplicate matchers) |
| `leads` | view, create, edit, archive, assign, export, manage (lead sources, lead workflow) |
| `dispatch` | view, create, edit, assign, manage |
| `jobs` | view, create, edit, archive, assign, approve, reject, export |
| `qualifications` | view, create, edit, archive, approve (verify credentials), manage (skill/certification catalog) |
| `notifications` | view, edit (own notifications only) |
| `job_types` | view, configure (job type catalog, job workflow settings) |
| `compensation` | view*, create, edit, approve*, reject, export, configure* |
| `financial_reports` | view*, export* |
| `performance` | view, export |
| `shifts` | view, create (start a shift), edit (end / correct one), approve (accept a shift started or ended under an exception) |
| `location` | view*, create (record an event: a technician's own), approve* (verify or override an arrival / location exception) |
| `job_outcomes` | view, create (report a visit outcome), edit (correct one), configure (lost reasons) |
| `completion_forms` | view (fill one in), configure (definitions per job type / category) |
| `recovery` | view, create, edit (work a case, record attempts), assign, approve (activate a high-impact rule, never its author), manage (author and test rules) |
| `follow_ups` | view, create, edit, assign |
| `materials` | view, create (propose a cost version), edit, archive, approve* (decide a cost change), export*; costs are the opt-in `cost` field set |
| `finance_ledger` | view*, export* |
| `finance_payments` | view, create* (record a payment), edit* (mark failed / void) |
| `finance_refunds` | view, create* (request), approve* (policy approver) |
| `finance_chargebacks` | view, create*, edit* (dispute workflow), approve* (decide a write-off) |
| `finance_adjustments` | view, create*, approve* |
| `finance_reconciliation` | view, create (start a run), edit (resolve an exception), assign, export* |
| `approvals` | view (own requests + approver queue), manage (see and cancel every request in scope), configure* (approval policies) |

Phase 2 additions (`qualifications`, `notifications`, `job_types`, and `manage` on customers/leads) are not rows of the
4.5 matrix; their defaults are in section 5 ("Phase 2 modules"). `notifications.*` is a capability check: the
service always returns only the caller's own notifications, whatever scope the assignment carries.

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
| `job_outcomes.financial_fields` | job_outcomes | `financial` |
| `location.coordinate_fields` | location | `coordinates` |
| `materials.cost_fields` | materials | `cost` |

`location.coordinate_fields` (spec 22.2): `LocationEvent.latitude` / `longitude` (`LOCATION_EVENT_FIELD_MAP`). A plain `location.view` grant reads when, what
kind, how accurate and what the server concluded, never where. Only the Owner/CEO template names it (`includeFields`); no other shipped template does.

Field maps (`field-maps.ts`) classify every stored column of `Employee`, `Customer`, `Lead` and `Job` (a test fails when a
column is added without a tag). Customer billing columns (`billingName`, `billingEmail`, `billingAddress`, `taxId`,
`paymentTerms`) are `billing`; job `quotedAmountMinor` and `currency` are `financial`. Leads have no sensitive set.
Because every field has ONE tag and read grants reveal whole sets, **read grants are plain** (no `fields` limit) for
Dispatcher and Technician: "operational / necessary fields" means "everything except the opt-in sensitive sets".
`fields` conditions remain on WRITE grants that must be narrower (Technician `leads.edit` -> `status`,
`jobs.edit` -> `execution`). The allowed fields are exported allowlists (`LEAD_STATUS_FIELDS` = status, closedReason;
`JOB_EXECUTION_FIELDS` = status, statusReason, startedAt, completedAt, instructions; `LEAD_WRITE_ALLOWLISTS` /
`JOB_WRITE_ALLOWLISTS` map tag -> list). Services MUST call, before applying an update, with the decision for the
record:

```ts
assertWritableFields(decision, Object.keys(changes), JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS); // throws ForbiddenError naming the fields
```

A named tag with an allowlist writes exactly that list; a plain grant (`base`) writes every non-sensitive field of the
map; sensitive sets only when named; unknown tags and denied decisions write nothing. **Technician customers**: the matrix's
"necessary fields" now means every non-billing field (plain `customers.view` grant with ASSIGNED scope; billing is opt-in).

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
| Customers | `customers.*` T | view, create, edit ORG_UNIT/T | view cond `{fields:"billing"}` T | view, create, edit ORG_UNIT | same | view cond `{set:"job_related"}` | view, create, edit cond `{set:"lead_related"}` | view ASSIGNED (plain grant: base fields, never billing) |
| Leads | `leads.*` T | view T | - | view, create, edit, assign ORG_UNIT | same | view cond `{set:"dispatch_related"}` | `leads.*` incl. `manage`, no archive | view ASSIGNED, edit cond `{fields:"status"}` |
| Dispatch | `dispatch.*` T | `dispatch.*` T | - | view, create, edit, assign ORG_UNIT | same | `dispatch.*` T | view (limited) ORG_UNIT | view OWN |
| Jobs | `jobs.*` T | `jobs.*` T | view cond `{fields:"financial"}` T | view, create, edit, assign ORG_UNIT | same | view, create, edit, assign (plain grants = operational fields, no financial set) T | view cond `{set:"recovery_related"}` | view ASSIGNED, edit cond `{fields:"execution"}` |
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
Technician-specific write qualifiers use `fields` (`status`, `execution`; reads are plain); the COO's
`permissions.assign` carries `{ set: "non_sensitive_roles" }`, to be enforced by the permissions module.

**MFA.** `Role.requiresMfa = true` for the Owner/CEO, Finance Director and HR Manager templates, for
any role holding `permissions.manage`, `permissions.assign` or a `*.configure` permission (this makes the
COO template MFA-required too), and for CUSTOM roles (no `templateKey`, clones included) holding any
sensitive permission or sensitive field set. Roles still carrying a template key (edits of a shipped template) keep the
template rule, so the Technician template stays MFA-free (a clone has no template key, so it is judged as custom). Authentication enforces it per request, not only at login
(a session that never passed MFA is sent back to the MFA step); the authz engine exposes the flag as
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

**Phase 2 modules (defaults, not in the 4.5 table).**

| Module | Owner/CEO | COO | State/Regional/City Mgr | Team Leader | Dispatcher | Lead Ops | Customer Relations | HR | Technician | Finance |
|---|---|---|---|---|---|---|---|---|---|---|
| `qualifications` | `*` | view | view, create, edit | view | view | - | - | `*` (incl. approve, manage) | view (OWN) | - |
| `notifications` | view, edit | view, edit | view, edit | view, edit | view, edit | view, edit | view, edit | view, edit | view, edit | view, edit |
| `job_types` | `*` | `*` (view, configure) | view | view | view | view | view | - | view | - |
| `customers.manage` | yes | - | - | - | - | - | - | - | - | - |
| `leads.manage` | yes | - | - | - | - | yes | - | - | - | - |
| `jobs.view {set:"customer_history"}` | (full) | (full) | (full) | - | - | - | yes | - | - | - |

`job_types.configure` makes the role require MFA (every `*.configure` does), which is why only Owner and COO hold it.
`qualifications.approve` (verifying licenses and certifications) stays with HR and the Owner so managers who record
credentials do not verify them. The `customer_history` set is passed by the customer history view only.

**Phase 3 modules (defaults, not in the 4.5 table; Owner/CEO holds every action, with the `coordinates` set).** Scope follows the assignment:
Technician `OWN` / `ASSIGNED`, managers their unit, COO / Owner tenant-wide. `location.view` and `location.approve` are `sensitive` (a custom role holding one
requires MFA; shipped operational templates stay MFA-free unless they hold a `*.configure`).

| Module | COO | State/Regional/City Mgr | Team Leader | Dispatcher | Lead Ops | Customer Relations | Technician |
|---|---|---|---|---|---|---|---|
| `shifts` | `*` | view, edit, approve | view | view | - | - | view, create, edit (own shift) |
| `location` | view, approve (no coordinates) | view, approve (no coordinates) | - | - | - | - | create (record own events; no history, no verification) |
| `job_outcomes` | `*` (incl. configure: lost reasons) + financial | view, edit + financial | view | view | view | - | view, create + financial |
| `completion_forms` | `*` (incl. configure) | view | view | view | - | - | view |
| `recovery` | `*` (incl. approve) | view | - | - | view, create, edit, assign, manage (no approve) | - | - |
| `follow_ups` | `*` | view, create, edit, assign | view, create, edit | view, create, edit | `*` | `*` | view, create, edit |

Design notes: (1) Lead Operations holds no `location.*` permission; technician presence reaches them only as the derived `presenceStatus` inside a
recovery case (AT_LOCATION / LEFT_LOCATION / UNKNOWN), never as coordinates or history. (2) `recovery.approve` (activating a high-impact rule) is held by
the COO and Owner only, so Lead Ops authors rules (`recovery.manage`) but a second person activates them; the database also refuses a high-impact rule that
is ACTIVE without an approver other than its author. (3) `job_outcomes.configure` and `completion_forms.configure` make a role require MFA (every
`*.configure` does), which is why only Owner and COO hold them. (4) Technicians record outcomes (`job_outcomes.create`) but cannot correct them
(`edit` is a manager's action); they hold no approve / manage / configure. (5) Outcome amounts, currency and payment status / method are the opt-in `financial` set (`job_outcomes.financial_fields`): held by Owner, COO, State / Regional / City managers and the Technician (who reports them), and by the Finance Director as a financial-only view. Team Leader, Dispatcher and Lead Operations see the outcome (type, reason, notes, follow-up request) but not the money from `job_outcomes` itself. **Lead Operations see outcome money only through the recovery case value** (`initialValueMinor` / `estimatedValueMinor` and the recovered / collected amounts, read under `recovery.view`): a case copies the quoted amount of its outcome, and that value stays visible to every case viewer by ruling (the END decision on it stays with the Owner). The rule **dry-run** keeps its redaction: it can target outcomes that have no case, so there the quoted value is shown to nobody without the `financial` set (`minValueMinor` / `maxValueMinor` checks come back `actual: null, redacted: true`).

**Disclosed "quote" sensitivities** (where a reader can learn a quoted amount without a dedicated finance grant): (a) a lead's base fields include `quotedAmountMinor`; (b) a job carries its money in the separate `financial` field set, but its base fields still show that it was quoted; (c) outcome money is the `financial` set above; (d) a recovery case carries the outcome's quoted value as the case value, visible to everyone holding `recovery.view` over the case. Whoever must not learn a quote must not hold `leads.view`, `recovery.view` or the matching job grants over that record.

Additional 4.4 role templates not in the 4.5 table are derived by analogy and flagged for
confirmation in `DECISIONS.md`:

| Template | Derived from | Scope |
|---|---|---|
| Regional Manager | State Manager | ORG_UNIT (region) |
| Team Leader | City Manager, read-mostly | ORG_UNIT (team) |
| Customer Relations | Customers scoped + leads view + job history (`customer_history` set) | ORG_UNIT |
| HR Manager | employees.* (incl. training/cert records later), base fields only (financial fields are opt-in) | TENANT |

Platform modules (not in 4.5): `users` and `audit` follow `permissions`/`company_settings`
(CEO full; others none by default); `localization` view for everyone, edit/configure for CEO.

## 6. Administration (spec 4.6) - implemented in Task 5 (`src/server/roles`, `/api/v1/roles/*`)

Create/clone roles, replace a role's permissions, archive, assign with scope and expiry
(`effectiveTo`), revoke (`revokedAt`, never delete), effective access, permission history (audit
events `role.*` / `role_assignment.*` with previous and new values), and the "why" diagnostic
(`explainAccess`). Permission map:

| Operation | Permission | Scope |
|---|---|---|
| list / read roles, history, effective access | `permissions.view` | roles: TENANT; effective access: over the target user |
| create / clone role | `permissions.create` | TENANT |
| edit role / replace permissions | `permissions.edit` | TENANT |
| archive role | `permissions.archive` | TENANT |
| grant / revoke assignment | `permissions.assign` | over the target user AND every scope handed out |
| translations save / review+delete (`i18n`) | `localization.edit` / `localization.configure` | TENANT |

Rules (all enforced in code, all tested):
- **No escalation through role definitions**: a permission (with its field sets and set qualifier) can be added to a role
  only by someone who holds it through one of their own grants (`assertMayDefineGrants`). Removing is always allowed.
- **Separation of duties (§21.3)**: nobody edits, re-permissions or archives a role that is assigned to themselves
  (`assertNotHoldingRole`; future-dated and temporary assignments count, expired and revoked ones do not).
- **Revoking needs the authority granting would**: `permissions.assign` over the target and over the assignment's scopes,
  with the COO `non_sensitive_roles` qualifier honoured, so a City admin cannot strip a tenant-wide assignment and a COO
  cannot revoke an Owner role. Revoking your own assignment is allowed (it only reduces access).
- **MFA flag**: a role with `permissions.manage|assign` or any `*.configure` requires MFA, as do the Owner, Finance and HR
  templates and custom roles (clones too) holding a sensitive permission or field set; the flag can be raised freely
  and never lowered while mandatory. It is enforced per request, not "at login".
- **Invitations obey the same rules** at creation and at acceptance (see `auth` README).

## 7. Testing obligations (spec 26.3)

Every module ships: permission tests (each role template x allowed/denied action), scope tests
(in-scope, out-of-scope, descendant, temporary assignment, expired/revoked), and tenant-isolation
tests for any tenant data it touches.

## 8. Customers: how scopes, sets and fields apply (Phase 2 Task 2)

Code: `src/server/customers/customer-access.ts` and `assignment-access.ts`.

- **ORG_UNIT / LEGAL_ENTITY**: the customer's service-area unit `Customer.orgUnitId` (and that unit's legal entity). A
  customer without a unit is tenant-level: only TENANT scopes reach it.
- **ASSIGNED**: a non-archived lead or job of the customer has an ACTIVE assignment to the caller; a job assigned to a team
  (`JobAssignment.teamOrgUnitId`) reaches every employee with an active placement in that team. Leads and jobs reuse the same
  where-fragments (`leadAssignedToWhere`, `jobAssignedToWhere`) for their own ASSIGNED scope. **OWN** matches nothing.
- **Record sets**: `job_related` (the customer has a non-archived job; Dispatcher), `lead_related` (has a non-archived lead or a lead recovery case; Lead
  Operations, so the customer of a case without a lead opens). Unknown sets match nothing. `customer_history` is a JOB set passed only by the customer history view.
- **Fields**: billing columns are the opt-in `billing` set (written only by grants naming it, never in audit values). A grant
  limited to `billing` (Finance) sees only billing columns and cannot search or filter by base columns. Technician (plain
  ASSIGNED grant) gets every non-billing field and cannot write.
- **Denials** on a customer are 404 (never 403) once a record is involved; creating without a tenant-wide grant and no unit is 403.
- **Duplicates**: flags are created from the whole tenant but shown/resolved only when the caller may view/edit BOTH customers;
  `customers.manage` (tenant-wide) configures the matchers.

## 9. Leads: how scopes, sets and fields apply (Phase 2 Task 5)

Code: `src/server/leads/lead-access.ts`, `src/lib/lead-lifecycle.ts`.

- **ORG_UNIT / LEGAL_ENTITY**: the lead's service-area unit `Lead.orgUnitId` (and that unit's legal entity). A lead without a unit is
  tenant-level: only TENANT scopes reach it (and only a tenant-wide grant may create one).
- **ASSIGNED**: the caller is the lead's current owner (ACTIVE `LeadAssignment`; shared fragment `leadAssignedToWhere`). Closing,
  releasing or archiving a lead ends the assignment, so the access ends with it. **OWN** matches nothing.
- **Record set** `dispatch_related` (Dispatcher `leads.view`): leads in QUALIFIED, SCHEDULED, DISPATCHED or CONVERTED. Unknown sets match nothing.
- **Actions**: `leads.create` (intake), `leads.edit` (content, status, contact history, customer link, duplicate decisions), `leads.assign`
  (assign, reassign, release), `leads.archive`, `leads.manage` (lead sources, tenant-wide). Conversion needs `leads.view` over the lead
  AND `jobs.create` over its service area. Technician `leads.edit {fields:"status"}` writes only `status` and `closedReason`
  (`LEAD_WRITE_ALLOWLISTS`), through the status action; it cannot log contact attempts or notes.
- **Fields**: leads have no sensitive set; every column is `base` (the quoted amount is a sales estimate).
- **Denials** on a lead are 404 once a record is involved; creating without a tenant-wide grant and no unit is 403.
- **Duplicates**: flags are created from the whole tenant but revealed only for records the caller may view; the review queue needs both sides.

## 10. Jobs: how scopes, sets and fields apply (Phase 2 Task 6)

Code: `src/server/jobs/job-access.ts`, `assignment.ts`, `status.ts`; decisions in `DECISIONS.md` "Phase 2 Task 6".

- **ORG_UNIT / LEGAL_ENTITY**: the job's service-area unit `Job.orgUnitId`. **ASSIGNED**: an ACTIVE `JobAssignment` to the caller, or to a team
  the caller currently belongs to (team expansion); assignments end at CLOSED / CANCELLED / unassign. **OWN** matches nothing. Record-set
  grants (`recovery_related`, `customer_history`) do not apply to the jobs endpoints; `customer_history` is passed only by the customer
  history view. Denials on a job are 404.
- **Fields**: money (`quotedAmountMinor`, `currency`) is the opt-in `financial` set. Writes check every field SENT with
  `assertWritableFields` and `JOB_WRITE_ALLOWLISTS`: the Technician's `jobs.edit {fields:"execution"}` covers `status`, `statusReason`,
  `instructions` only (and only a move to EN_ROUTE through the plain transition; arrival and start of work are the field events `/arrive` and `/start-work`, which need the same `jobs.edit` and a writable `status`). *Superseded wording: "in Phase 2".* Trails (history, events, assignments) need the base field set.
- **Operations**: create `jobs.create` (unit-level; tenant-wide for a customer with no unit); edit / transition / reschedule `jobs.edit`;
  assign, reassign, unassign `jobs.assign`; closing a job that was AWAITING_REVIEW `jobs.approve` (**and `jobs.assign` while the job still has active assignments**: the close ends them), reopening it `jobs.reject`;
  workflow switches `job_types.configure` (tenant-wide).
- **Assignment override** (assigning an employee who fails hard eligibility): `jobs.approve` over the job plus a reason. Default holders: Owner/CEO
  and COO. The Dispatcher template does not hold it on purpose; a tenant may grant it to a custom role. Employment failures cannot be overridden.

## 11. Phase 4: finance, materials and approvals (permission catalog + templates)

Defaults (templates in `role-templates.ts`; a tenant edits its own copy afterwards):

| Module | Owner | COO | Finance Director | State / Regional / City Mgr | Team Leader, Dispatcher, Technician | Others |
|---|---|---|---|---|---|---|
| `materials` | full + `cost` set | view, create, edit, archive (no costs, no approve) | view, approve, export + `cost` set (no catalog editing) | view (no costs) | view (no costs) | - |
| `finance_ledger` | full | view | full | view (scope) | - | - |
| `finance_payments` | full | view | full | view (scope) | - | - |
| `finance_refunds` | full | view | full | view, create (request) | - | - |
| `finance_chargebacks` | full | view | full | view | - | - |
| `finance_adjustments` | full | view | full | view, create (request) | - | - |
| `finance_reconciliation` | full | view | full | view | - | - |
| `approvals` | full | view, manage | full (incl. configure policies) | view | - | - |

Rules:
- **Finance gains nothing operational** (spec 26.3): the Finance Director template holds no `dispatch`, `jobs.edit/assign`,
  `employees.edit` or `materials.create/edit`. A test pins it.
- **Who decides** a request is the approval policy's `approverPermission` (a key such as `finance_refunds.approve`), checked inside the
  request's scope by the approval service. Holding `approvals.view` alone never lets someone decide. The requester and anyone listed in
  `excludedApproverIds` can never decide it (service check + database trigger).
- **Seeing a request** needs `approvals.view` plus one of: being its requester, holding its `approverPermission` over its unit, or
  `approvals.manage` over its unit (else 404). Manage-only viewers (the COO template) do not see the amount or details (`moneyRedacted`).
  Cancelling: the requester or `approvals.manage`. Policies (`/approvals/policies`) need `approvals.configure` at TENANT scope.
- **Sensitive** (`*` above): reading or exporting the ledger, recording / deciding money, and `approvals.configure` (an `.configure`
  key also forces MFA). Custom roles holding any of them require MFA (the existing `customRoleRequiresMfa` rule).
- **Scopes**: finance data carries `orgUnitId` (and `legalEntityId` on the ledger and reconciliation runs), so ORG_UNIT and LEGAL_ENTITY
  scopes apply; the Finance Director and Owner are assigned at TENANT.
- **Finance review flags** (`FinanceReviewFlag`, spec 11.7) use the reconciliation module, no new keys: listing / reading
  `finance_reconciliation.view` (scoped by the flag's `orgUnitId`; a flag without a unit needs TENANT scope), assigning
  `finance_reconciliation.assign`, resolving `finance_reconciliation.edit`. Raising one is a side effect of a money or job service
  (no permission of its own) or, by a person, `finance_reconciliation.create`.
- **COO and material costs**: the COO maintains the catalog but does not see costs or approve cost changes (the `cost` set and
  `materials.approve` are Owner / Finance Director only). Spec 4.5 gives the COO "View" on financial reports, not cost data;
  a tenant can grant the set to its COO role.
- **Materials in practice** (Task 2): catalog reads are the `materials.view` capability (tenant-wide reference data); catalog writes need
  TENANT scope. Proposing or withdrawing a cost needs `materials.create` AND the `cost` set (so the COO template cannot propose costs);
  cost-change requests are tenant-level, decided with `materials.approve` at TENANT scope. Costing a job's materials or reading its direct
  material cost needs `jobs.view` over the job plus the `cost` set.
- **Compensation stays untouched**: `compensation.*` and `financial_reports.*` keep their Phase 1 meaning; no commission or payroll
  permission is added (blocked on the owner's compensation specification, spec 28.4).
- **Ledger and payments endpoints (Task 4)**: entries and balances `finance_ledger.view`; recording a payment and confirming an
  outcome's charge / collection `finance_payments.create` (confirming also needs the `job_outcomes` `financial` set over the job);
  receiving / failing / voiding a payment and reversing a charge `finance_payments.edit`; payments, the confirmation queue and providers
  `finance_payments.view`; the provider intake log `finance_payments.view` at TENANT scope. Finance reaches a job through its unit only:
  OWN / ASSIGNED scopes never match finance records. A legal entity's totals need TENANT or that LEGAL_ENTITY scope.
