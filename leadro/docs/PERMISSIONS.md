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
| `performance` | view (metric values; coaching content is the opt-in `coaching` set), edit (add context to a value or period), export*, manage (run a computation), configure (author / submit metric definition versions), publish* (approver of a definition's publication) |
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
| `training` | view, create (record a completion), edit (change an assignment: due date, cancel), assign (assign a course; accept / dismiss a training recommendation), approve (verify, reject or revoke a record), manage (course catalog) |
| `development_plans` | view*, create, edit (goals, actions, status, add a review entry) |
| `coaching` | view*, create, edit |
| `data_challenges` | view*, assign (give a challenge to a reviewer), approve (uphold), reject |
| `customer_feedback` | view, create (record manually), edit (void a mis-recorded entry) |
| `analytics_executive` | view (executive dashboards, spec 13.1, 5.1) |
| `analytics_operational` | view (operational dashboards, spec 13.2, 5.2-5.5) |
| `analytics_financial` | view* (financial dashboards, spec 13.3, 5.7) |
| `analytics_lead` | view (lead dashboards, spec 5.6) |
| `reports` | view (run reports, own and role-shared saved views), create (save views; edit / archive own), export* (also needs the dataset's own export permission; audited), manage (share views with roles, archive others' views) |
| `background_jobs` | view (the tenant's jobs and scheduled definitions; system jobs are never visible to a tenant), manage (retry a dead job, enable / disable the tenant's definitions) |
| `automation` | view (rules, versions, execution log), configure* (author versions, dry run, activate a low-impact version, retire), approve* (approver of a high-impact activation, never its author) |
| `integrations` | view (integrations, status, error logs, inbound webhook events; no secret exists to show), configure* (configuration, credentials reference, connection test, enable / disable), manage (replay a failed inbound event, reset an open circuit) |
| `payroll_exports` | view*, create (prepare a time-and-attendance batch), approve* (approver of a batch's release), export* (download / send an approved batch). Time facts only, never wages (spec 11.9) |
| `accounting_exports` | view*, create (prepare a journal export), export*, approve* (approver of an account mapping's activation), configure* (author / submit mapping versions) |

`PUBLISH` is an 11th action beyond spec 4.3's ten (Phase 5, see section 12): the approval policy for metric publication names
`performance.publish` as its approver permission, so publishing is a different person's decision than authoring (`performance.configure`).

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
| `performance.coaching_fields` | performance | `coaching` |

`performance.coaching_fields` (spec 10.4, 22.2): the coaching content around performance data read through `performance.*`:
`MetricContextNote.body` (`METRIC_CONTEXT_NOTE_FIELD_MAP`) and the coaching notes, plans and challenges that development read models
(Phase 5 Task 6) embed. Metric values themselves are all `base` (`PERFORMANCE_METRIC_VALUE_FIELD_MAP`). The coaching, plan and challenge
records' own endpoints are gated by their own (sensitive) modules. Named by the management chain and HR only (section 12).

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
| Performance | `performance.*` + `coaching` set T | view T (no `coaching` set) | - | view, edit + `coaching`, manage ORG_UNIT | same | - | view cond `{set:"lead_team", includeFields:["coaching"]}` | view OWN (no `coaching` set) |
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
- **Reconciliation endpoints (Task 6)**: starting a run `finance_reconciliation.create` with TENANT or that LEGAL_ENTITY scope (a
  tenant-wide run: TENANT); reading runs, exceptions and the summary `finance_reconciliation.view`; assigning / unassigning
  `finance_reconciliation.assign` (the assignee must hold `finance_reconciliation.edit` over the exception); resolving
  `finance_reconciliation.edit`. Exceptions are scoped by the unit recorded at detection (none = TENANT only); runs by legal entity, so
  unit managers (view at ORG_UNIT) see their units' exceptions but no runs or entity totals. Outcome amounts inside an exception also need
  the `job_outcomes` `financial` set (else redacted). `finance_reconciliation.export` is not used yet (no export endpoint).
- **Refunds, chargebacks, adjustments, review flags in practice (Task 5)**: requesting a refund (against a payment of the job) and paying it
  out `finance_refunds.create`; requesting an adjustment `finance_adjustments.create`; recording a chargeback `finance_chargebacks.create`,
  its dispute / won / lost / write-off request `finance_chargebacks.edit`; reads `*.view`; all over the job's CURRENT unit (never OWN /
  ASSIGNED). Deciding is the approval policy's approver permission (defaults `finance_refunds.approve`, `finance_adjustments.approve`,
  `finance_chargebacks.approve`); the requester, and for a write-off the person who recorded the chargeback, never decide. Unit managers
  (templates) may request refunds and adjustments in their unit and pay out the refunds they may request; the Finance Director / Owner
  record chargebacks. Review flags: read `finance_reconciliation.view` over the flag's unit, raise by hand `finance_reconciliation.create`,
  assign / unassign `finance_reconciliation.assign` (only to someone who can see the flag), resolve `finance_reconciliation.edit`. None of
  these touches employees' pay: there is no wage deduction or commission effect anywhere (spec 11.7).
- **Phase 4 review (hardening)**: reversing a CHARGE and voiding a RECEIVED payment stay single-person corrections under
  `finance_payments.edit` (no approval policy), but each raises a finance review flag (`ledger.charge_reversed`,
  `payment.voided_after_receipt`) so a second finance person sees it; whether they should need an approval is an owner decision
  (`MILESTONE-4.md`). An approver of a MATERIAL_COST_CHANGE request who lacks the `materials.view` `cost` set decides without seeing the
  unit costs (`moneyRedacted`). Known open points for the owner: an `approvals.configure` holder can deactivate the policy covering their
  own request (policy changes are audited, not approved), and unit managers may record the payout of an approved refund.

## 12. Phase 5: workforce intelligence (permission catalog + templates)

Defaults (templates in `role-templates.ts`; a tenant edits its own copy afterwards). Scope follows the assignment: managers their
unit, Team Leader the team unit, Technician `OWN`, Owner / COO / HR tenant-wide.

| Module | Owner | COO | Finance | State / Regional / City Mgr | Team Leader | Lead Ops | HR | Customer Relations | Dispatcher | Technician |
|---|---|---|---|---|---|---|---|---|---|---|
| `performance` | full + `coaching` | view | - | view, edit + `coaching`; manage | view, edit + `coaching` | view + `coaching` `{set:"lead_team"}` | view, edit + `coaching`; configure | - | - | view (OWN) |
| `training` | full | view | - | view, edit, assign | view | view `{set:"lead_team"}` | full | - | - | view (OWN) |
| `development_plans` | full | - | - | view, create, edit | view | - | full | - | - | - (self-service) |
| `coaching` | full | - | - | view, create, edit | view, create, edit | view, create `{set:"lead_team"}` | full | - | - | - (self-service) |
| `data_challenges` | full | - | - | view, assign | - | - | full | - | - | - (raised through self-service) |
| `customer_feedback` | full | view | - | view | view | - | - | full | - | - |

Rules:
- **Spec 10.3 is structural.** No template that dispatches (Dispatcher) holds any performance or development permission, and no
  Phase 5 permission grants anything on dispatch, jobs, employees, compensation or qualification eligibility. An architecture test
  (Task 3) asserts that dispatch / qualifications / jobs / ledger / approvals / employees never import the performance modules,
  and (review P5-R7) never name a performance, coaching, development, challenge or feedback table either.
- **Coaching content** (`performance.coaching_fields`, tag `coaching`, spec 22.2) is named only by the employee's management chain
  (State / Regional / City managers, Team Leader, Lead Operations for the lead team), HR and the Owner. The COO sees metric values
  ("Performance: View", spec 4.5) without it. Coaching notes, plans and challenges are also their own modules whose `view` is
  sensitive, so a custom role holding one requires MFA.
- **Self-service (spec 5.11).** Employees read their own published metric values with evidence, training records and assignments,
  certification status, their non-DRAFT plans, the coaching and context notes marked shared, and their own challenges through
  `/api/v1/me/*` (Task 6), and raise challenges there. Those paths filter on the caller and need no module permission; the
  Technician template's `performance.view` / `training.view` (OWN) remain for the module endpoints.
- **Development dashboard** (`GET /api/v1/employees/{id}/development`, Task 6): `performance.view` over the employee. Positions compare
  with the colleagues in the VIEWER's `performance.view` scope only. Coaching notes, context notes, plans and review history appear only
  when the viewer's grant over the employee names the `coaching` set and (notes / plans) they hold `coaching.view` /
  `development_plans.view`; recommendations need `training.view`. A missing section is `null`, not an error, so the COO sees values and
  positions but no coaching content (ruling 1).
- **Metric definitions.** HR (and the Owner) author versions (`performance.configure`, which forces MFA like every `*.configure`).
  Publishing always goes through the approval engine (subject `PERFORMANCE_METRIC_DEFINITION`, seeded policy
  `performance_metric_publication`, approver permission `performance.publish`, held by the Owner only by default); the author can never
  decide it (separation of duties). The database refuses a PENDING_APPROVAL or PUBLISHED version without an approval request.
- **HR (spec 5.8)**: full training (catalog, assignments, recording and verifying completions), plans, coaching, and the review of
  employee-submitted corrections (`data_challenges.approve` / `.reject`). Still no financial data (no finance module, no compensation,
  no financial field set; a test pins it).
- **Managers (spec 5.4)**: assign training and accept / dismiss recommendations (`training.assign`), run plans and coaching, add context to
  values (`performance.edit`), trigger a computation for their unit (`performance.manage`), route challenges to a reviewer
  (`data_challenges.assign`). They do not record or verify completions, decide challenges, export, author or publish metrics.
- **Customer Relations** records customer feedback manually (no survey provider) and voids a mis-recorded entry; feedback becomes a
  metric input only through a published CUSTOMER_FEEDBACK_AVERAGE definition.
- **Nobody acts on their own records through a management grant** (Phase 5 review, `docs/reviews/phase5-review.md`). A manager placed in
  their own unit, or HR with a tenant-wide grant, has their own employee record inside their scope; the module endpoints still treat
  it as out of reach:
  - coaching notes, context notes and development plans about the caller are left out of lists and are a 404 on single reads and on
    changes (P5-R1/R2); the caller reads what was shared with them through `/api/v1/me/*` (shared notes, non-draft plans without the
    review text). The development dashboard of oneself therefore shows no coaching content;
  - writing coaching / context notes or creating a plan about oneself is a 403 (Task 4 / 5);
  - accepting or dismissing a training recommendation about oneself, and changing, starting or cancelling one's own training
    assignment, are a 403 (P5-R2); assigning oneself a course and recording one's own completion stay allowed (verification is
    another person's, `assertNotOwnRecord`);
  - recording or voiding customer feedback that names oneself is a 403 (P5-R5);
  - a computation's answer leaves out the caller's own preview values (P5-R4); reads already did.
- **Separation of duties in reviews and publication.** The author AND every editor of a metric definition version are excluded from
  approving its publication (P5-R3); a challenge's reviewer is never its raiser, the challenged employee, or the author of a challenged
  coaching note (P5-R6).
- **`lead_team`** is a record set no service resolves yet (it already qualified Lead Ops' `employees.*` and `performance.view`); until a
  service supplies it, those grants match nothing (fail closed).
- Tests: `tests/authz/workforce-catalog.test.ts` (catalog, templates, labels), `tests/db/phase5-schema.test.ts` (schema).

## 13. Phase 6: enterprise analytics (permission catalog + templates)

Two layers, both required (spec 13.4, 22.2):

1. **Dashboard family**: `analytics_executive.view`, `analytics_operational.view`, `analytics_financial.view` (sensitive),
   `analytics_lead.view` open that family's dashboards (`/api/v1/analytics/*`, Phase 6 Task 4).
2. **Per KPI**: every KPI in `src/lib/kpi-catalog.ts` names its own required permission and field set (Tasks 2-3). A dashboard shows a
   KPI only when the caller also holds that, inside their scope. So a family grant never reveals data its holder could not read
   otherwise; e.g. revenue on the executive or a manager's dashboard needs `financial_reports.view` (+ the financial set the KPI names).

Report builder (spec 13.5): `reports.view` runs reports and the caller's own or role-shared saved views; `reports.create` saves views and
edits / archives the caller's own; `reports.manage` shares views with roles and archives other people's; `reports.export` (sensitive)
exports rows. Every dataset also names its own read and export permission (e.g. `jobs.view` / `jobs.export`, `financial_reports.export`),
so an export needs `reports.export` **and** the dataset's export permission; columns are gated by field sets, and every attempt (refused
and failed ones included) is logged in `ReportExport` plus an audit event. **A saved or shared view never widens access**: whoever runs it
is checked with their own permissions, scope and field sets.

The spec's 4.5 matrix has no "Reports" row; "Financial reports" (`financial_reports`) is unchanged. Defaults follow the 5.x workspaces
("Reports" navigation: Executive, COO, Lead Operations, Finance, HR; widget lists for managers and the dispatcher):

| Template | Dashboard families | `reports` | Scope |
|---|---|---|---|
| Owner / CEO | all four | view, create, export, manage | TENANT |
| COO | executive, operational | view, create | TENANT |
| Finance Director | financial | view, create, export | TENANT |
| State / Regional / City Manager | operational (local revenue via their scoped `financial_reports.view` per KPI) | view, create | ORG_UNIT |
| Lead Operations Manager | lead | view, create, export (they already hold `leads.export`) | ORG_UNIT |
| Dispatcher | operational `{ set: "dispatch_kpis" }` | - | ORG_UNIT |
| HR Manager | - | view, create | TENANT |
| Team Leader, Customer Relations, Technician | - | - | - |

Rules:
- **`dispatch_kpis`** is a KPI set the catalog defines (Task 2): the dispatcher's grant covers only the KPIs placed in it (unassigned jobs,
  time to assignment, time to arrival, dispatch efficiency). The analytics engine passes a KPI's sets as the `ResourceRef.sets` of the
  check, so a KPI outside the set is not covered (fail closed, like every `set` qualifier).
- **Finance gains no operational dashboards** (spec 26.3); the COO and managers get no financial dashboard family.
- **Employee-level analytics** stay in the Phase 5 read models (`performance.*`); no dashboard family ranks individuals (spec 10.3-10.4).
- **MFA**: a custom role holding `analytics_financial.view` or `reports.export` requires MFA (sensitive permissions).
- **Per-KPI requirement (Task 2)**: a catalog entry's `access` = any one of its `permissions` + its `fieldSet` + its `sets`; the KPI's
  scope is the union of the qualifying grants' TENANT / ORG_UNIT scopes (OWN, ASSIGNED, LEGAL_ENTITY cover no KPI). Operational KPIs:
  `analytics_operational.view`; lead and recovery KPIs: `analytics_lead.view` or `analytics_executive.view`; financial KPIs:
  `financial_reports.view` (Task 3 may tighten the field set). The full list per KPI is in `docs/KPI_DEFINITIONS.md`.
- Tests: `tests/authz/analytics-catalog.test.ts` (catalog, templates, labels), `tests/db/phase6-schema.test.ts` (schema),
  `tests/analytics/*` (KPI catalog, engine access and scope, routes).

## 14. Phase 7: integrations and automation (permission catalog + templates)

| Template | `background_jobs` | `automation` | `integrations` | `payroll_exports` | `accounting_exports` |
|---|---|---|---|---|---|
| Owner / CEO | view, manage | view, configure, approve | view, configure, manage | view, create, approve, export | view, create, export, approve, configure |
| Finance Director | - | - | - | - | view, create, export, configure (mapping proposals) |
| HR Manager | - | - | - | view, create, export | - |
| Everyone else | - | - | - | - | - |

Rules:
- **Configuration is the Owner's** ("Owner/Admin configure"; the template set has no separate Admin role): automation, integrations and
  the tenant's schedules. A tenant gives a custom admin role these permissions; `*.configure` forces MFA like every configure permission.
- **Separation of duties through the approval engine** (seeded policies in `prisma/seed/finance-specs.ts`, one approval each, the
  author / preparer excluded): `automation_rule_activation` (subject `AUTOMATION_RULE_VERSION`, approver `automation.approve`, only for
  high-impact versions), `accounting_mapping_activation` (`ACCOUNTING_MAPPING`, `accounting_exports.approve`, always),
  `payroll_export_release` (`PAYROLL_EXPORT`, `payroll_exports.approve`, always). By default only the Owner approves, so Finance proposes
  mappings and HR prepares payroll batches, and a second person releases them.
- **Payroll boundary (spec 11.9, 28.4)**: `payroll_exports` covers time and attendance facts only (shifts, approved hours, job counts).
  No Phase 7 permission reads or writes compensation; Finance holds no payroll export permission and HR no accounting one.
- **Secrets**: no permission reveals a secret. Integrations store only a credentials reference (`env:` / `vault:`), so
  `integrations.view` shows the reference name, never a value.
- **Automation actions run with the rule's authority, not a user's**: Task 3 executes actions through the owning modules' public APIs
  as a system actor and records the rule version in the audit and in the outbox causation chain. The action registry decides which
  actions exist: none changes compensation, eligibility or employment status, offers discounts automatically or uses performance data
  to restrict work (spec 9.6, 10.3).
- **System jobs** (no tenant) are invisible to every tenant (RLS); only the worker path sees them (DECISIONS "Phase 7 Task 1").
- Tests: `tests/authz/integrations-catalog.test.ts` (catalog, templates, policies, labels), `tests/db/phase7-schema.test.ts` (schema).
