# LEADRO Architecture (Phase 0)

Authority: `SPEC.md` (sections 2, 3, 4, 19-22). Status: approved baseline for Phase 1; revise via
`DECISIONS.md`.

## 1. Style

Modular monolith (spec 2.3): one Next.js 15 deployable, one PostgreSQL 16 database, strict internal
module boundaries. No microservices. Heavy reporting and route optimisation are designed to be
split out later (read replica / worker) but are not split now.

## 2. Modules (spec 2.2)

Each backend module lives in `src/server/<module>/` and exposes its public interface only through
`index.ts`. A module may import another module only via that module's `index.ts` (never reach into
its internals, never into its tables directly). Enforced by review and, later, an ESLint
`no-restricted-imports` rule.

| # | Module (spec 2.2) | Directory | Phase |
|---|---|---|---|
| 1 | Identity and Authentication | `identity` | 1 |
| 2 | Tenant Management | `tenants` | 1 |
| 3 | Organization Management | `organization` | 1 |
| 4 | User and Employee Management | `people` | 1 |
| 5 | Authorization | `authz` | 1 |
| 6 | Customer Management | `customers` | 2 |
| 7 | Lead Management | `leads` | 2 |
| 8 | Job Management | `jobs` | 3 |
| 9 | Dispatch and Scheduling | `dispatch` | 3 |
| 10 | Field Operations | `field` | 3 |
| 11 | Qualification | `qualification` | later |
| 12 | Performance and Development | `performance` | later |
| 13 | Lead Recovery | `lead-recovery` | later |
| 14 | Financial Management | `finance` | blocked (28.4) |
| 15 | Compensation and Commissions | `compensation` | blocked (28.4) |
| 16 | Notifications | `notifications` | later |
| 17 | Workflow Automation | `automation` | later |
| 18 | Analytics and Reporting | `reporting` | later |
| 19 | Integrations | `integrations` | later |
| 20 | Audit and Compliance | `audit` | 1 |
| 21 | Localization | `localization` | 1 |

Cross-cutting platform code lives in `src/server/db` (client, `withTenant`), and later
`src/server/http` (request pipeline helpers). Only modules marked Phase 1 are in scope for the
current plan; the rest are listed so boundaries are agreed up front.

## 3. Layering inside a module

```
route handler (src/app/api/v1/...)      thin: parse, call service, map result/error
  -> service      (src/server/<m>/service.ts)  business rules, state validation, audit
      -> repository (src/server/<m>/repo.ts)   Prisma queries, always through `tx` from withTenant
          -> PostgreSQL (RLS enforces tenant isolation as the last line of defence)
```

- Services receive an `AuthContext` (user, tenant, effective permissions + scopes) and never trust
  anything from the client except validated input.
- Repositories only receive a `TenantTx` and never import the global `prisma` for tenant tables.
- UI never contains business rules; it renders what the API returns.

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
4. **Application checks**: authenticate -> tenant membership -> permission/scope (section 6).
5. The app role is a non-superuser without `BYPASSRLS`. Migrations run as the same role (it owns
   the tables); there is no separate privileged path in application code.

Tables without RLS: `Tenant` (resolved by slug at login; exposes only id/slug/name/status/locale
defaults) and `Permission` (global catalog, no tenant data).

Unauthenticated lookups that must find a row before the tenant is known (session token, invitation
token, password-reset token) embed the tenant id in the opaque token (`<tenantId>.<random>`); the
server opens `withTenant(tenantId)` and then looks up the SHA-256 hash.

## 5. Request pipeline (spec 20.1, 20.3, 20.4)

Every `/api/v1/...` operation passes the same stages, in order:

1. **Correlation**: read or generate `x-correlation-id`; echo it on every response.
2. **Authenticate**: resolve the session cookie/bearer token -> user + tenant. Reject expired,
   revoked, deactivated, or locked users.
3. **Tenant**: open `withTenant(session.tenantId)`; all further work uses that `tx`.
4. **Authorize (RBAC)**: does an active, non-expired role assignment grant `module.action`?
   Re-evaluated on every request (spec 25.5); nothing cached across requests.
5. **Validate input**: Zod schema for params/query/body; reject unknown fields.
6. **Scope (ABAC)**: resolve the caller's data scopes over the org tree and apply them to the
   query / target record (see `PERMISSIONS.md`).
7. **Idempotency**: for retriable mutations, honour `Idempotency-Key` (`IdempotencyRecord`).
8. **Business-state validation**: state transitions, invariants, separation of duties.
9. **Execute** in the same transaction.
10. **Audit**: append an `AuditEvent` in the same transaction (denied/failed attempts are audited
    too, in their own transaction, with outcome DENIED/FAILED).
11. **Respond** with the success body or the structured error (`API_CONVENTIONS.md`). Stack traces
    and database errors are logged server-side with the correlation id and never returned.

## 6. Authorization model (spec 4.2)

RBAC: a tenant-configurable `Role` is a bundle of `Permission` rows (module + action).
ABAC: each `RoleAssignment` carries one or more `AccessScope` rows (TENANT, LEGAL_ENTITY, ORG_UNIT
with descendants, OWN, ASSIGNED). Effective access = union over the user's active assignments of
(permission, scope). Role names and template keys never influence decisions. Details and the
default matrix: `PERMISSIONS.md`.

## 7. Organization and history (spec 3.2-3.3)

One typed tree (`OrgUnit`: BUSINESS_UNIT, STATE, REGION, CITY, BRANCH, DEPARTMENT, TEAM) separate
from `LegalEntity` (the legal employer) and `Tenant`. Employees are placed by
`OrganizationalAssignment` rows with effective dates; moves close the old row and open a new one,
so historical reports resolve "where was this employee on date D". Managers are many-to-many via
`OrgUnitManager`. See `ERD.md`.

## 8. Audit (spec 21)

`AuditEvent` is append-only: a trigger raises on UPDATE, DELETE and TRUNCATE. Records follow 21.2
(tenant, actor, action, target, timestamp, previous/new value, reason, source app, correlation id).
Secrets (password hashes, MFA secrets, tokens) are redacted before a value is written.

## 9. Localization and time (spec 16)

Locales `en-US`, `es-US`, `he-IL` (he-IL renders `dir="rtl"`). Effective locale resolution:
user.locale -> branch/org-unit default -> tenant default. Time zone likewise. All timestamps are
stored as UTC `timestamptz`; formatting happens at the edge. UI text is referenced by translation
key; `TranslationResource` holds optional per-tenant overrides. Internal enums/statuses are
language-neutral English identifiers.

## 10. Technology and deviations

Stack as in spec 2.4 narrowed per the project rulings (`DECISIONS.md`): local credential auth behind
an interface instead of a managed IdP; no queue, object storage, maps or notification providers
yet (no fake integrations, spec 28.3). The mobile app (React Native) is out of scope for this plan.
