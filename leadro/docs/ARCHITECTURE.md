# LEADRO Architecture (Phases 0 - 3 backend, as built)

Authority: `SPEC.md` (sections 2, 3, 4, 19-22). This document describes the code as it exists at
the end of the Phase 3 backend (Milestone 2+3, `MILESTONE-2-3.md`); where the code and an earlier plan differ, this file follows the code. Revise via
`DECISIONS.md`.

## 1. Style

Modular monolith (spec 2.3): one Next.js 15 deployable, one PostgreSQL 16 database, strict internal
module boundaries. No microservices. Heavy reporting and route optimisation are designed to be
split out later (read replica / worker) but are not split now.

## 2. Modules

Each backend module lives in `src/server/<module>/`, has a short `README.md`, and exposes its public
interface only through `index.ts`. A module may import another module only through that module's
`index.ts`. This is enforced by an ESLint `no-restricted-imports` rule (`@/server/*/*` is an error
in `src/`); tests may import internals when they need to.

| Module | Directory | What it owns |
|---|---|---|
| Authentication | `auth` | local credential login, sessions, lockout, MFA (TOTP), invitations, password reset/change |
| Authorization | `authz` | permission catalog, role templates, `can`/`enforce*`, scopes, field projection, role assignment rules |
| Organization | `organization` | org-unit tree, legal entities, managers, tenant profile (`/tenants/current`), unit history |
| Employees | `employees` | employee records, placements over time, termination, invitations of employees |
| Users | `users` | user accounts (list, preferences, deactivate), own-account reads/writes |
| Roles | `roles` | tenant roles (create, clone, edit, archive), role assignments, effective-access diagnostic |
| Notifications | `notifications` | events -> inbox rows in the business transaction, after-commit delivery through channel interfaces, retries, recipient resolution, own-notification API |
| Audit | `audit` | append-only `AuditEvent` writer and readers |
| i18n | `i18n` | per-request locale chain and tenant translation overrides (server side; catalogs live in `src/lib/i18n`) |
| Core | `core` | request pipeline (`defineRoute`), `Actor`, error hierarchy, pagination, idempotency |
| Logging | `logging` | structured JSON logger with redaction |
| DB | `db` | Prisma client and `withTenant` |
| Customers | `customers` | customer records, service addresses, notes, preferred employees, service history, duplicate detection; also the shared assignment/scope helpers (`teamMembers`, `jobAssignedToWhere`) |
| Leads | `leads` | lead intake, lifecycle, ownership, contact attempts, duplicate flags, conversion to a job |
| Jobs | `jobs` | job creation, the lifecycle machine (`src/lib/job-lifecycle.ts`), assignment with enforced eligibility, rescheduling, trails, job events |
| Dispatch | `dispatch` | hard eligibility filter, explainable recommendations, dispatcher decisions and overrides, dispatch modes, the dispatch picture |
| Qualifications | `qualifications` | skills, certifications, licenses, job-category permissions, service territories, availability, the eligibility inputs |
| Shifts | `shifts` | work shifts and the exceptions around starting / ending them |
| Location | `location` | location events (verification, departure, navigation), retention settings, presence helpers; coordinates never leave it |
| Arrival | `arrival` | arrive / start-work field steps and manager verification of arrivals |
| Field events | `field-events` | the ONE offline gate (`runFieldEvent`): idempotency per (tenant, employee, `clientEventId`), content hash, believable device time, stored verdicts |
| Field execution | `field-execution` | notes, materials, attachment metadata (storage provider port), versioned completion forms and submissions |
| Field sync | `field-sync` | the batch endpoint and its handler registry; the meaning of each event type stays with the owning module |
| Job outcomes | `job-outcomes` | the outcome of every visit, lost reasons, the `job.not_converted` domain event, `holdsOutcomeFinancialSet` |
| Recovery | `recovery` | recovery rules (versioned, approval for high impact), the engine subscribed to the outcome event, cases, attempts, presence snapshot, recovery summary |
| Follow-ups | `follow-ups` | follow-up tasks about a lead, customer, job or recovery case; overdue / due-soon sweep; per-target access registry |
| Approvals | `approvals` | Phase 4: the generic approval engine: versioned policies (subject type, currency, amount band), requests that snapshot them, append-only decisions, single / dual approval, separation of duties, expiry sweep, the approver queue, and the subject registry (`registerApprovalSubject`) through which materials and finance subjects are called back |
| Ledger (Phase 4) | `ledger` | the append-only ledger: the one idempotent posting / reversal path, derived balances and payment status per job / customer / legal entity |
| Payments (Phase 4) | `payments` | payment records (manual, status changes), finance-confirmed revenue from outcomes, the `PaymentProvider` port (not configured) and the authenticated provider intake |
| Materials | `materials` | Phase 4: the material catalog, versioned costs (proposed through the approval engine as `MATERIAL_COST_CHANGE`, effective on their date, never overlapping) and the costing of job material usage (frozen snapshot of the version in effect at usage time, half-even extended cost), direct material cost per job |
| Finance corrections (Phase 4) | `finance-adjustments` | refunds against received payments, chargebacks (manual and provider intake, dispute, write-off), adjustments of what a customer owes, all with approval per policy and ledger postings / reversals; finance review flags (raised once per triggering event: reopened job, corrected outcome, refund paid out, chargeback opened) and their assign / resolve workflow |

Not built (spec 2.2 modules for later phases): performance, finance and compensation (blocked on an
approved compensation spec, 28.4), automation, reporting, integrations, and every UI for the Phase 2
and 3 modules (the backend is complete behind `/api/v1`; screens are deferred). There is no
tenant-provisioning module: tenants come from the seed.

**Ports (provider seams) without a provider.** No fake integrations exist (spec 28.3): the storage
provider (`setStorageProvider`, default `notConfiguredStorage`, so attachment upload targets answer
"not configured"), the notification channels (email / SMS / push; the in-app inbox works), and
geocoding (addresses keep their coordinates only when a person supplies them) are interfaces with no
implementation.

**Registries on `globalThis`.** Next.js bundles `src/instrumentation.ts` and the route handlers
separately, so a module-level Map would be filled in one bundle and empty in the other. Three
registries therefore live on `globalThis` (same pattern as the Prisma client): the notification
target resolvers (`notifications/target-access.ts`), the outcome-recorded handlers
(`job-outcomes/events.ts`) and the follow-up target access (`follow-ups/targets.ts`; the unregistered
recovery-case default fails closed). The approval subject handlers (`approvals/registry.ts`), the job status-change handlers (`jobs/status-events.ts`), the outcome-corrected handlers (`job-outcomes/events.ts`) and the provider intake event handlers (`payments/intake-handlers.ts`) follow the same pattern. `src/server/notification-targets.ts` is the one place that
registers them at start-up (called from `src/instrumentation.ts` and the notifications route).

**Shared offline gate.** Every technician write that can arrive late from a device (shifts, location
events, arrival, start work, notes, materials, attachments, completion, outcomes, follow-up status,
status transitions to EN_ROUTE) goes through `field-events` `runFieldEvent` or one of its two shells
(`arrival/own-field-write.ts`, `field-execution/access.ts`), and `assertBelievableEventTime` is the
single device-time rule. A refusal marked `retryable` (an earlier event has not arrived yet, decided
by `canStillReach` over the job machine) is never stored, so the same `clientEventId` can succeed
later; every other verdict is stored with the id.

**Cross-module data access rule.** A module may READ another module's tables only for read models
(lists, projections, existence checks) and only inside the caller's transaction; a WRITE to another
module's tables always goes through that module's `index.ts` (service function or `...InTx`
function taking the caller's `tx`). Reads still go through the owner's index when the owner already
exports the access rule (for example `resolveJobListAccess`, `resolveCustomerListAccess`).

Shared pure code (no database) is in `src/lib` (`i18n` catalogs and translator, `totp`,
`changed-fields`, `redact`, `org-hierarchy`). UI is in `src/app` (pages, server actions) and
`src/components/ui`.

## 3. Layers

```
route handler (src/app/api/v1/...)   thin: defineRoute({ schemas, authenticate, authorize, handler })
  -> service function (src/server/<m>/*.ts)   business rules, in-transaction permission check, audit
      -> Prisma through `tx` from withTenant   (PostgreSQL RLS is the last line of defence)

server component / server action (src/app/...)   authenticates from the cookie, then calls the SAME services
```

- There is **no repository layer**: services query Prisma directly through the `tx` that
  `withTenant` gives them (fewer files, one place to read a rule). Queries that must stay identical
  across modules live in one exported helper instead (for example `activePlacementWhere` in `authz`).
- Services receive an **`Actor`** (`tenantId`, `userId`, `employeeId`, `sessionId`, `locale`) and
  never trust anything from the client except validated input. Permissions are NOT cached in the
  actor: every service re-checks inside its own transaction (`enforceInTx`).
- The UI contains no business rules; it renders what the services return and shows translated
  messages chosen by error code.

## 4. Tenant isolation (spec 3.1, 26.2)

Defence in depth, innermost first:

1. **Database**: every tenant-owned table has `tenantId` + FK + index and a FORCE RLS policy
   `"tenantId" = NULLIF(current_setting('app.tenant_id', true), '')`. A missing setting yields NULL,
   so the policy fails closed (no rows, no writes).
2. **Composite foreign keys** `(parentId, tenantId) -> (id, tenantId)` so a row can never reference
   a parent in another tenant (FK checks bypass RLS, so this must be structural).
3. **`withTenant(tenantId, fn)`**: the single entry point. Opens a transaction and runs
   `set_config('app.tenant_id', <id>, true)` (transaction-local: cannot leak across pooled
   connections).
4. **Application checks**: authenticate -> permission/scope (section 6).
5. The app role is a non-superuser without `BYPASSRLS`. Migrations run as the same role (it owns
   the tables); there is no separate privileged path in application code.

Tables without RLS: `Tenant` (resolved by slug at login) and `Permission` (global catalog). Because
the runtime role owns them it can also write them; a REVOKE is planned for Phase 8 hardening.

Unauthenticated lookups that must find a row before the tenant is known (session token, invitation
token, password-reset token) embed the tenant id in the opaque token (`<tenantId>.<random>`); the
server opens `withTenant(tenantId)` and then looks up the SHA-256 hash.

## 5. Request pipeline (spec 20.1, 20.3, 20.4)

`defineRoute` (in `src/server/core`) runs every `/api/v1/...` operation through the same stages:

1. **Correlation**: read or generate `x-correlation-id`; echo it on every response.
2. **Authenticate** (`authenticate` hook): session cookie -> `Actor`. Expired, revoked, deactivated
   users and sessions still owing MFA are refused (an MFA-requiring role granted mid-session sends
   the session back to the MFA step).
3. **Content type and size**: a mutating request with a body must be `application/json` (415) and
   at most 1 MB (413). This is the JSON-only CSRF layer, with SameSite=Lax cookies.
4. **Validate input**: Zod schemas for params, query and body.
5. **Authorize** (`authorize` hook, `requirePermission` or `requireTenantLevelPermission`): checks
   the permission and the record's data scope; a denial is audited.
6. **Idempotency** (`idempotent: true` routes with an `Idempotency-Key`): the stored response is
   replayed; keys are scoped per tenant and user.
7. **Handler -> service**: the service opens `withTenant`, **re-checks the permission inside its own
   transaction** (`enforceInTx`, so it is safe from any caller), applies the data scope in the query,
   validates business state, executes, and appends the `AuditEvent` in the same transaction.
8. **Respond** with the success body or the structured error (`API_CONVENTIONS.md`). Stack traces
   and database errors are logged server-side with the correlation id and never returned.

So the order is: authenticate -> content type -> Zod -> authorize -> handler (service: enforce ->
state validation -> execute -> audit). Tenant always comes from the session.

Web pages and server actions skip the route layer but go through the same services; refusals there
are audited by `recordAuthzDenial` (server actions via `runAdminAction`, pages via `loadForPage`).

## 6. Authorization model (spec 4.2)

RBAC: a tenant-configurable `Role` is a bundle of `Permission` rows (module + action).
ABAC: each `RoleAssignment` carries one or more `AccessScope` rows (TENANT, LEGAL_ENTITY, ORG_UNIT
with descendants, OWN, ASSIGNED). Effective access = union over the user's active assignments of
(permission, scope). Role names and template keys never influence decisions. Sensitive field sets
(financial, billing) are opt-in per grant, and records are projected through explicit field maps.
Details and the default matrix: `PERMISSIONS.md`, `AUTHZ.md`.

## 7. Organization and history (spec 3.2-3.3)

One typed tree (`OrgUnit`: BUSINESS_UNIT, STATE, REGION, CITY, BRANCH, DEPARTMENT, TEAM) separate
from `LegalEntity` (the legal employer) and `Tenant`. Employees are placed by
`OrganizationalAssignment` rows with effective dates; moves close the old row and open a new one,
so historical reports resolve "where was this employee on date D". Managers are many-to-many via
`OrgUnitManager`. "In effect" for any dated row is defined once (`activePlacementWhere`,
`openEndedWhere`). See `ERD.md`.

## 8. Audit (spec 21)

`AuditEvent` is append-only: a trigger raises on UPDATE, DELETE and TRUNCATE (a table owner could
still drop the trigger; DDL-owner/runtime-role separation is Phase 8). Records follow 21.2
(tenant, actor, action, target, timestamp, previous/new value, reason, source app, correlation id).
Secrets are redacted before a value is written. There is an engine and readers for role and
org-unit history; there is no audit-log API or UI yet.

## 9. Localization and time (spec 16)

Locales `en-US`, `es-US`, `he-IL` (he-IL renders `dir="rtl"`). Effective locale: user.locale ->
branch/org-unit default -> tenant default; time zone likewise. Timestamps are stored as UTC
`timestamptz`; formatting happens at the edge. UI text is referenced by translation key;
`TranslationResource` holds per-tenant overrides that are served only once reviewed (§16.6).
`npm run i18n:check` verifies every catalog has the same keys and placeholders.

## 10. Technology and deviations

Stack as in spec 2.4 narrowed per the project rulings (`DECISIONS.md`): local credential auth behind
an interface instead of a managed IdP; no queue, scheduler or worker process, object storage, maps / geocoding, or notification providers
(no fake integrations, spec 28.3, so invitation and reset emails cannot be delivered; the overdue
sweep and the pending-notification delivery are functions a future worker calls). There is no
unauthenticated integration intake for leads (webhook / API-key sources). The mobile app (React
Native) and every Phase 2 / 3 screen are not built; the field-sync and `/api/v1` contracts are what
they will consume.
