# Project state

Last updated: end of Milestone 1 (Phase 0 + Phase 1). Full report: `MILESTONE-1.md`.

## Done

- Scaffold: Next.js 15, React 19, strict TypeScript, Prisma 6, Vitest, Tailwind 3, ESLint (with an
  index-only module import rule).
- Database: 19 models, 6 migrations, FORCE RLS on all tenant-owned tables, append-only audit trigger,
  org-tree and effective-date constraints, dev seed (permission catalog + two demo tenants).
- Server modules (`src/server`): `auth`, `authz`, `organization`, `employees`, `users`, `roles`,
  `audit`, `i18n`, `core`, `logging`, `db`. Each has a README; cross-module use is through `index.ts`.
- 41 route handlers under `/api/v1` (auth, tenants/current, organization, employees, users, roles).
- Screens: login, MFA enroll/verify, password reset/accept invitation, account security and sessions,
  administration (company, organization, branches, history, employees, users, roles, localization).
- Localization in en-US, es-US, he-IL (RTL) with reviewed tenant overrides.
- Tests: 60 files, 624 tests passing against the real database; typecheck, lint, i18n check and
  production build pass (numbers in `MILESTONE-1.md`).

## Not done / next

- **No notifier/email provider**: invitations and password resets cannot reach a real user.
- **No tenant provisioning** (seed only; `GET/PATCH /tenants/current`) and **no audit-log API/UI**.
- Phase 2: React Native field app, customers, leads. Phase 3: jobs, dispatch, field operations.
- **Phase 4 (finance, compensation) is blocked** on an approved compensation spec (spec 28.4).
- Managed identity provider to replace local credentials; legal review items (spec 22.3).
- Phase 8 hardening: REVOKE on `Tenant`/`Permission`, DDL owner vs runtime role, shared rate-limit
  store, denial-audit throttling.

## Known limitations / open items

See `MILESTONE-1.md` section 6 for the complete list. Headlines:

- MFA enrollment is trust-on-first-use for un-enrolled MFA-role users; no recovery flow.
- Rate limiting is in memory per instance; audit immutability is trigger-only.
- Role templates for Regional Manager, Team Leader, Customer Relations and HR are provisional pending
  product confirmation.
- The Playwright smoke run was a one-off manual check, not an automated suite; UI tests are at
  server-action and component level only.
- No claim of security review, compliance, or production readiness (spec 28.7).
