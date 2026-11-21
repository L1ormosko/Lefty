# LEADRO — Implementation Plan: Phase 0 (Architecture) + Phase 1 (Platform Foundation)

Spec: `leadro/docs/SPEC.md` (Master Product Specification v1.0 — binding authority).
Manager: project controller. Implementers/reviewers: subagents.

## Context

The repository `Lefty` already contains VELTO (an unrelated billboard marketplace) at the
repo root. LEADRO is built as a **separate, self-contained application in `leadro/`**.
Nothing outside `leadro/` may be modified (except root `.gitignore` if strictly needed).

## Global Constraints (bind every task)

- Stack (spec §2.4): Next.js 15 App Router + React 19 + TypeScript (strict) + Prisma 6 +
  PostgreSQL 16 + Zod + Vitest + Tailwind 3. Pin exact versions (no `^`), same versions as the
  root VELTO `package.json` where the package overlaps. No new dependency without listing it in
  `leadro/docs/DECISIONS.md` with a reason.
- Modular monolith (§2.3). Server modules live in `leadro/src/server/<module>/` with an
  `index.ts` public interface; modules import each other only through `index.ts`.
- Database: local Postgres at `postgresql://leadro:leadro@127.0.0.1:5432/leadro` (app role,
  NOT superuser, NO BYPASSRLS) and test DB `leadro_test`. Migrations via `prisma migrate`.
- Tenant isolation (§3.1, §26.2): every tenant-owned table has `tenantId` + FK + index, AND a
  Postgres Row-Level-Security policy `tenant_id = current_setting('app.tenant_id')`, with
  `FORCE ROW LEVEL SECURITY`. All tenant-scoped queries run through a single helper
  `withTenant(tenantId, fn)` that opens a transaction and `set_config('app.tenant_id', …, true)`.
  Frontend filtering is never the boundary.
- Identity: a User belongs to exactly one tenant; email unique per tenant. Login takes a
  company code (tenant slug) + email + password.
- Authorization (§4.2): RBAC (actions per module) + ABAC (data scopes over the org tree). Role
  names never determine access — only granted permissions + scopes. Re-evaluated on every
  request (§25.5). Backend-enforced.
- API (§20): under `/api/v1/...`. Every operation: authenticate → tenant → permission → Zod
  input validation → business-state validation → structured error → audit event.
  Structured error JSON: `{ error: { code, message, field?, retryable, correlationId } }`.
  Never leak stack traces or DB errors. Every request carries/returns `x-correlation-id`.
  Retriable mutations accept `Idempotency-Key`.
- Audit (§21): append-only `AuditEvent` table (DB trigger rejects UPDATE/DELETE). Fields per §21.2.
  Sensitive values (password hashes, MFA secrets, tokens) redacted.
- Localization (§16): all user-facing UI text via translation keys; locales `en-US`, `es-US`,
  `he-IL`; `he-IL` renders `dir="rtl"`. Internal statuses/enums are language-neutral English
  identifiers. No hardcoded UI strings in components.
- Money: integer minor units (cents) as `BigInt`/`Int` — never floats (§11.8). (No financial
  logic in this plan — Phase 4 is blocked on an approved compensation spec, §28.4.)
- No fake integrations (§28.3). No claims of compliance or production readiness (§28.7).
- Tests: Vitest; integration tests hit the real `leadro_test` database. Every module ships
  permission tests and tenant-isolation tests where it touches tenant data.
- Commits: conventional style, English, scoped `leadro`, e.g. `feat(leadro/auth): ...`.

## Task 1: Scaffold + Phase 0 architecture docs + core schema

Create the `leadro/` Next.js project (package.json, tsconfig strict, next.config, tailwind,
postcss, eslint, vitest.config, `.env.example`, `.gitignore` for leadro). Scripts: `dev`,
`build`, `typecheck`, `lint`, `test`, `db:migrate`, `db:reset:test`, `seed`.

Create Postgres role/databases (document the commands in `leadro/README.md`; a script
`leadro/scripts/setup-db.sh` that is idempotent and uses `sudo -u postgres psql`).

Prisma schema for Phase 1 entities (§19.1 Organization + Identity and Access + Platform subset):
Tenant, LegalEntity, OrgUnit (typed: BUSINESS_UNIT, STATE, REGION, CITY, BRANCH, DEPARTMENT, TEAM;
parentId self-relation; optional legalEntityId; branch fields: address, timezone, operating hours
JSON, active), OrgUnitManager (unit ↔ employee, many-to-many, effective dates), User, Employee
(1:1 optional with User; legalEntityId = legal employer), OrganizationalAssignment (employee →
org unit, effectiveFrom/effectiveTo, reason, createdBy), OrgChangeHistory (or reuse audit +
assignment history — decide and document), Role, Permission (catalog: module + action),
RolePermission, RoleAssignment (user → role, effectiveFrom/To for temporary access, grantedBy),
AccessScope (on RoleAssignment: scope type TENANT | LEGAL_ENTITY | ORG_UNIT (incl. descendants)
| OWN | ASSIGNED), Session, AuthenticationEvent, Invitation, PasswordResetToken, AuditEvent,
IdempotencyRecord, TranslationResource (optional overrides).
Language preferences: Tenant.defaultLocale, OrgUnit(branch).defaultLocale, User.locale nullable.
Time zone: Tenant.defaultTimeZone, OrgUnit.timeZone, User.timeZone nullable. Timestamps stored UTC.

Initial migration + a hand-written SQL migration adding: RLS policies (FORCE) on every
tenant-owned table, the append-only trigger on AuditEvent, a CHECK that an OrgUnit is not its own
parent. `leadro/src/server/db/` exports `prisma` and `withTenant`.

Phase 0 docs in `leadro/docs/`: `ARCHITECTURE.md` (modules §2.2, layering, request pipeline),
`ERD.md` (mermaid ER diagram of the schema), `PERMISSIONS.md` (permission catalog, the §4.5
default matrix mapped to permissions + scopes, data-scope rules), `API_CONVENTIONS.md`,
`DECISIONS.md` (all rulings below + any made in this task), `PROJECT_STATE.md`.

Test: an integration test proving RLS — with `withTenant(A)` a row of tenant B is invisible and
an insert with tenantId B fails; and that AuditEvent UPDATE/DELETE is rejected.

## Task 2: Core request pipeline — errors, correlation IDs, idempotency, audit engine

`src/server/core/`: AppError hierarchy (codes: UNAUTHENTICATED, FORBIDDEN, NOT_FOUND,
VALIDATION_FAILED, CONFLICT, INVALID_STATE_TRANSITION, RATE_LIMITED, INTERNAL) mapped to HTTP
status + structured JSON; correlation ID middleware/helper; `defineRoute()` helper for
`/api/v1` route handlers that composes: correlation id → (auth hook placeholder injected in Task 3)
→ Zod parse → handler → error mapping. Idempotency: `withIdempotency(tenantId, key, scope, fn)`
storing request hash + response; same key + different payload → CONFLICT.
`src/server/audit/`: `recordAudit(tx, event)` with redaction of sensitive keys, source app,
correlation id; query API for audit timeline (tenant-scoped, paginated).
Structured logging helper (JSON lines, no secrets).
Tests: error mapping never leaks internals; idempotency replay returns the same response and does
not run fn twice (including concurrent duplicate); redaction.

## Task 3: Authentication module

`src/server/auth/`: password hashing (bcryptjs, cost 12), password policy (min 12 chars),
login by tenant slug + email + password; generic error on failure (no enumeration);
account lockout after 5 failed attempts in 15 min (locked 15 min); sessions (random token, only
SHA-256 hash stored, httpOnly secure sameSite=lax cookie, idle + absolute expiry, revoke, list
own sessions); deactivation revokes all sessions; invitations (single-use hashed token, expiry
72h, accept sets password); password reset (single-use hashed token, 1h, revokes sessions,
response identical whether or not the email exists); AuthenticationEvent for every login success/
failure/lockout/logout/reset/MFA event (login history); MFA TOTP (RFC 6238, implemented with
node:crypto — no new dep) with enrollment + verification, required at login when any of the
user's roles has `requiresMfa`; rate limiting on login/reset endpoints (in-DB or in-memory
fixed window, documented). `requireSession()` for server components/actions and the auth hook
for `defineRoute`. API: `/api/v1/auth/login|logout|mfa/*|invitations/accept|password-reset/*|sessions`.
Audit login and failed access.
Tests: lockout, enumeration-safety, token single-use, MFA required path, deactivated user can't
log in and loses sessions, cross-tenant login with same email resolves to the right tenant only.

## Task 4: Authorization engine (RBAC + ABAC)

`src/server/authz/`: permission catalog constant (modules from §4.5 rows × actions §4.3:
VIEW, CREATE, EDIT, ARCHIVE, ASSIGN, APPROVE, REJECT, EXPORT, MANAGE, CONFIGURE) plus
field-level sensitive categories (e.g. `employees.financial_fields`, `customers.billing_fields`);
role templates for §4.4 (Owner/CEO, COO, Finance Director, State Manager, Regional Manager, City
Manager, Team Leader, Lead Ops Manager, Dispatcher, Customer Relations, HR Manager, Technician)
derived from the §4.5 matrix and created per tenant (roles are editable templates, `isTemplate`
origin only). Core API: `can(actor, permission, resource?)` → `{ allowed, reason, via }` and
`scopeFilter(actor, permission)` → Prisma where-fragment over org units (descendant expansion of
the org tree; OWN/ASSIGNED scopes). Temporary access: expired RoleAssignments are ignored.
`explainAccess(actor, targetUser|resource)` diagnostic ("Why can this user access this record?").
`assertNotSelfApproval(actorId, subjectCreatedById)` separation-of-duties helper.
`requirePermission` wired into `defineRoute`.
Tests (§26.3 + §25.5): City Manager can't read another city's employees; Finance Director has no
dispatch permission; Technician can't read another technician's profile; Dispatcher can't
configure; temporary permission expiry; manager losing org assignment loses scope immediately;
cross-tenant access denied even with forged ids; role named "CEO" without permissions gets nothing.

## Task 5: Organization + Employee services and API

`src/server/organization/` + `src/server/employees/`: tenant/company profile (view/edit), legal
entities CRUD, org unit create/rename/move/archive with validation (no cycle, allowed parent types
documented as configurable default, no move under archived unit), assign/unassign managers
(multiple managers per unit; one manager over multiple units), employee CRUD (invite links to
Task 3 invitations), organizational assignment with effective dates (history kept, never
overwritten; temporary assignments; legal employer separate from operational team), org history
query (previous/new/effective date/user/reason), `orgUnitAt(employee, date)` for historical
reporting. All writes audited, permission-checked with scope, inside `withTenant`.
API under `/api/v1/organization/*`, `/api/v1/employees/*`, `/api/v1/users/*`, `/api/v1/roles/*`
(role create/clone/edit permissions, assign/revoke with scope + expiry, effective access,
permission history), `/api/v1/tenants/current`. Paginated lists.
Development seed `prisma/seed.ts`: two tenants (to prove isolation), a realistic US hierarchy
(legal entities A/B, Texas/Florida/California states, regions, cities, branches, teams) and one
user per role template; password from env `SEED_PASSWORD` (≥ 16 chars, refuse otherwise, never printed).
Tests: cycle prevention, history preservation, scope-filtered lists, API permission/isolation tests.

## Task 6: Localization engine

`src/lib/i18n/`: message catalogs `en-US.json`, `es-US.json`, `he-IL.json` with identical key sets
(keys UPPER_SNAKE or dotted — choose and document; e.g. `JOB_STATUS.COMPLETED`); `t(key, params)`
with fallback chain user → branch → company → en-US; missing key never renders broken UI (renders
fallback + logs once in dev); locale resolution helper per §16.2; `dir` per locale; Intl-based
formatters for date/time (time-zone aware, per business context), numbers, currency (USD minor
units), phone (E.164 display, no dep), plus a script/test `i18n:check` that fails on missing or
extra keys across catalogs and on hardcoded JSX text in `src/app` and `src/components`
(simple heuristic lint). Translation versioning: catalog `version` field + `TranslationResource`
tenant overrides marked `reviewed` (unreviewed overrides are not served).
Tests: catalog parity, fallback, RTL dir, formatting with different time zones.

## Task 7: Design system + app shell + auth screens

`src/components/ui/`: Sidebar, TopNav (language switcher, user menu, notification bell
placeholder that says "no notifications" truthfully), Search, FilterPanel, DataTable (server-side
pagination, sorting, filters, empty state that explains next step), Pagination, StatusBadge (text +
icon, never color only), UserProfileCard, Dialog (confirmation for destructive actions), Drawer,
Form primitives with field-level errors, DatePicker (native input wrapper), AuditTimeline.
Restrained enterprise palette, logical CSS properties (`ms-`/`me-`, `start/end`) so RTL works.
Keyboard accessible, labelled. Layout: `(auth)` login (company code, email, password, MFA step),
accept invitation, forgot/reset password; `(app)` workspace shell whose navigation is computed from
the user's permissions (§5 workspaces; only items the user can access).
Root layout sets `lang` and `dir` from resolved locale. All strings via i18n keys.
Tests: component tests for DataTable/StatusBadge/Dialog where practical; RTL snapshot of shell.

## Task 8: Administration screens

Pages in `(app)/admin/`: Company Overview (§3.4), Organization Structure (searchable tree; add,
rename, move with validation errors shown, assign managers/employees, assignment history),
Branch Management, Organization History, Employees directory + profile (respecting field-level
permissions), Users & invitations, Roles & Access (create/clone role, permission grid,
assign with scope + expiry, revoke, effective access view, permission history, "Why can this user
access this record?" diagnostic). All via server actions/API that reuse Task 4/5 services —
no business logic in components. Every screen: one primary action, empty states, pagination.
Tests: server-action permission tests; Playwright smoke (login as CEO in English, as City Manager
in Hebrew RTL, verify scoping on employee list) if Playwright runs in the environment.

## Task 9: Milestone hardening + report

Run full typecheck, lint, unit + integration tests, i18n:check, build. Fix failures. Write
`leadro/docs/MILESTONE-1.md` per §28.7 (implemented features, changed files, DB changes, API
changes, tests executed/passed/failed, known limitations, security implications, remaining tasks)
and update `PROJECT_STATE.md`. Document blocked items: Phase 4 financial logic needs an approved
compensation spec (§28.4); managed identity provider replacement; React Native app in Phase 2;
legal review items §22.3.
