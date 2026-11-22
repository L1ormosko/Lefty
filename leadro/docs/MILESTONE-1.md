# Milestone 1 report: Phase 0 (architecture) + Phase 1 (platform foundation)

Format follows spec §28.7. This is a working prototype of the platform foundation. **It is not
production-ready and makes no security-review or legal-compliance claim.**

## 1. Implemented features

**Platform**
- Multi-tenant PostgreSQL schema with FORCE row-level security on every tenant-owned table,
  composite tenant-safe foreign keys, and an append-only audit table.
- Request pipeline `defineRoute` (correlation id, authenticate, JSON-only/size check, Zod, authorize,
  handler, structured errors), cursor pagination, idempotency keys (per tenant and user), structured
  redacting logger.
- Localization: en-US, es-US, he-IL (RTL), locale chain user -> branch -> company, tenant translation
  overrides with a review step, `i18n:check` catalog consistency script.

**Authentication** (`auth`): company code + email + password login, lockout, rate limits, sessions
(idle/absolute expiry, immediate revocation), TOTP MFA with encrypted seeds and replay protection,
MFA re-checked on every request (a role granted mid-session forces the MFA step), invitations,
password reset and change, session list/revoke.

**Authorization** (`authz`): 14-module permission catalog, 12 role templates, RBAC + scoped ABAC
(tenant, legal entity, org-unit subtree, own, assigned), sensitive field sets (financial, billing)
with per-row projection, anti-escalation and separation-of-duties rules for roles and lock-outs,
`explainAccess`, failed-access auditing for API routes, server actions and pages.

**Organization / people**: org-unit tree (type rules, move, archive, managers, history from the audit
trail), legal entities, tenant profile, employees with dated placements and termination, user
accounts (list, preferences, deactivate), roles (create, clone, edit, archive, history), role
assignments and an effective-access diagnostic.

**Administration UI** (server-rendered, translated): company overview, organization tree, branches,
organization history, employees (+ invite, placements, terminate), users (+ deactivate), roles and
assignments, localization overrides; login, MFA enroll/verify, forgot/reset password, accept
invitation, account security and sessions. Plus a `/dev/ui` component gallery.

## 2. Changed files (summary by module; ~390 files, ~41k lines vs. the Phase 0 base)

| Area | Content |
|---|---|
| `prisma/` | schema (19 models), 6 migrations, seed (catalog + two demo tenants) |
| `src/server/auth` (23 files) | login, sessions, MFA, invitations, reset, lockout, rate limiter, TOTP seed encryption |
| `src/server/authz` (29 files) | catalog, templates, evaluate/can/enforce, scope filters, field maps, role-assignment rules, denial audit, time-window predicates |
| `src/server/organization` (12), `employees` (9), `users` (6), `roles` (7) | the services behind the routes and screens |
| `src/server/core`, `audit`, `i18n`, `logging`, `db` | pipeline, audit writer/readers, locale + overrides, logger, `withTenant` |
| `src/app/api/v1` | 41 route files (section 5) |
| `src/app/(app)`, `(auth)` | screens and server actions |
| `src/components/ui`, `src/lib` | design-system primitives, catalogs, TOTP, redaction |
| `tests/` | 56 test files plus 4 component test files |
| `docs/` | ARCHITECTURE, ERD, PERMISSIONS, API_CONVENTIONS, CODING_STANDARDS, AUTH, AUTHZ, DECISIONS, PROJECT_STATE, this report |

## 3. Database changes (migrations, in order)

1. `20261121134018_init`: all Phase 1 tables.
2. `20261121134040_rls_and_constraints`: FORCE RLS policies, append-only audit trigger, org-tree
   cycle guard, effective-date and scope CHECKs, one-PRIMARY-placement exclusion constraint.
3. `20261121150000_auth_session_mfa_pending`: `Session.mfaPending`.
4. `20261121150000_translation_review`: `TranslationResource.reviewed/reviewedAt/reviewedById`.
5. `20261121160000_auth_fix_round_1`: `User.mfaLastUsedStep`; `Invitation` role scope columns.
6. `20261122100000_auth_session_mfa_verified_at`: `Session.mfaVerifiedAt` (column only).

## 4. Tests

Final run, in `leadro/`:

| Check | Result |
|---|---|
| `npm test` (Vitest, real Postgres 16) | **60 files, 624 tests: 624 passed, 0 failed, 0 skipped** (~172 s) |
| `npm run typecheck` | passed, 0 errors |
| `npm run lint` | passed, 0 problems (includes the index-only import rule) |
| `npm run i18n:check` | passed |
| `npm run build` | passed (Next.js production build) |

Coverage is by behaviour, not by percentage: RLS isolation and fail-closed behaviour, every route's
permission/scope/404-vs-403 behaviour, audit rows for each mutation and for denials, MFA and session
rules, anti-escalation paths, idempotency, UI server actions and pages (rendered through test fakes
of `next/*`), and catalog/RTL checks. A one-off Playwright smoke run of the screens was done by hand
during development; it is **not automated and not reproducible from the repository**.

## 5. API changes (all under `/api/v1`)

- **auth**: `POST login`, `logout`, `mfa/enroll|confirm|verify`, `invitations/accept`,
  `password-reset/request|confirm`; `GET sessions`, `DELETE sessions/{sessionId}`.
- **tenants**: `GET`, `PATCH /tenants/current`.
- **organization**: `GET|POST units`, `GET|PATCH units/{id}`, `POST units/{id}/move|archive`,
  `GET|POST units/{id}/managers`, `DELETE units/{id}/managers/{managerId}`;
  `GET|POST legal-entities`, `GET|PATCH legal-entities/{id}`, `POST legal-entities/{id}/archive`.
- **employees**: `GET|POST employees`, `GET|PATCH employees/{id}`, `POST employees/{id}/terminate`,
  `GET|POST employees/{id}/assignments`, `POST employees/{id}/assignments/{assignmentId}/end`,
  `GET employees/{id}/org-unit-at`, `POST employees/{id}/invitations`.
- **users**: `GET users`, `GET|PATCH users/{id}`, `POST users/{id}/deactivate`, `GET users/me`,
  `POST users/me/password`.
- **roles**: `GET|POST roles`, `GET|PATCH roles/{id}`, `PUT roles/{id}/permissions`,
  `POST roles/{id}/clone|archive`, `GET roles/{id}/history`, `GET|POST roles/assignments`,
  `POST roles/assignments/{id}/revoke`, `GET roles/effective-access`.
- **Pipeline behaviour changes in the final fix wave**: mutating requests with a body must be
  `application/json` (new error `UNSUPPORTED_MEDIA_TYPE`, 415) and at most 1 MB (new error
  `PAYLOAD_TOO_LARGE`, 413); idempotency keys are private to the user who sent them.
- There is no per-endpoint API reference beyond the module READMEs and `docs/API_CONVENTIONS.md`.

## 6. Known limitations

Missing capabilities (do not assume these exist):
- **No notifier or email provider exists.** Invitations and password resets cannot reach a real user:
  the default notifier only logs without the token (§28.3: no fake integrations). A person can be
  onboarded today only by a developer reading the seed/test path or wiring a real notifier.
- **Tenant provisioning is absent.** Tenants exist only through the seed; the API offers only
  `GET`/`PATCH /tenants/current`.
- **No audit-log API or UI.** The audit engine writes everything; the only readers are role history
  and organization-unit history.
- **Playwright smoke was a one-off manual run**, not automated or reproducible.
- **§26.7 Definition-of-Done gaps**: no per-endpoint API reference beyond module READMEs and the
  conventions; UI tests exist only at server-action and component level (no browser-level suite).
- Pickers are capped at 200 entries; some admin lists are capped at 50 with no pager.

Security-relevant limitations:
- **MFA enrollment is trust-on-first-use** for an MFA-role user who has not enrolled yet: whoever holds
  that session first binds the authenticator. There is no recovery or MFA-disable flow.
- **Rate limiting is in memory per instance**; with several instances the limits multiply (the database
  lockout after repeated failures is the real brute-force control).
- **Audit immutability is trigger-only**: the table owner (the runtime role today) can drop the trigger.
- **The `Tenant` and `Permission` tables have no RLS** and the runtime role can write them. A REVOKE and a
  separate DDL owner are planned for Phase 8.
- **OWN + financial field sets** can be granted by any single covering part of the granter's access (a narrow
  rule; a stricter intersection rule is not implemented).
- **Denial auditing has no rate limit**: a user who keeps hitting refused endpoints can flood the audit table.
- Local credentials only; a managed identity provider replaces them later (interface exists, see DECISIONS).

Product decisions pending:
- The role templates for **Regional Manager, Team Leader, Customer Relations and HR Manager** are
  **provisional** until product confirms them (they are derived, not in the §4.5 matrix). The HR
  template does not see financial fields.
- Custom roles with a sensitive permission or sensitive field set require MFA; the shipped operational
  templates (for example Technician) do not.

## 7. Security implications

- Every query runs inside `withTenant`, so tenant isolation holds even if application code forgets a
  filter; composite FKs prevent cross-tenant references.
- Authorization is re-evaluated on every request and again inside each service transaction; record
  outside the caller's scope answers 404, so existence is not confirmed.
- Secrets: bcrypt (cost 12) password hashes, SHA-256-hashed tokens, AES-256-GCM encrypted TOTP seeds
  (`LEADRO_ENCRYPTION_KEY` required; MFA fails closed without it), redaction in logs and audit values.
- JSON-only mutating bodies plus SameSite=Lax cookies are the CSRF defence; there are no CSRF tokens.
- Failed access is audited for API routes, server actions and pages, but not for requests refused
  before an actor exists (garbage cookies are only logged, to avoid audit flooding).
- Nothing here has had an external security review, penetration test, or compliance assessment.

## 8. Remaining tasks

- Phase 2: React Native field app; customers and leads.
- Phase 3: jobs, dispatch and scheduling, field operations.
- **Phase 4 (financial and compensation logic) is blocked** on an approved compensation specification (§28.4).
- Replace local credentials with a managed identity provider; add a real notifier (email/SMS) so
  invitations and resets can be delivered.
- Tenant provisioning; audit-log API and UI with export; per-endpoint API reference; browser-level
  automated UI tests; recovery/MFA-disable flows.
- Phase 8 hardening: REVOKE on `Tenant`/`Permission`, separate DDL owner, shared rate-limit store,
  denial-audit throttling, penetration test.
- Legal review items in §22.3 (retention, privacy, consent) are open.
- Product confirmation of the provisional role templates.
