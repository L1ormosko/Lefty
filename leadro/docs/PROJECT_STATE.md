# Project state

Last updated: end of the Phase 5 backend (Milestone 5). Reports: `MILESTONE-1.md`, `MILESTONE-2-3.md`, `MILESTONE-4.md`, `MILESTONE-5.md`.

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

## Phase 2 + 3 backend (done, no UI)

- 14 more server modules (customers, leads, jobs, dispatch, qualifications, shifts, location, arrival, field-events, field-execution, field-sync, job-outcomes, recovery, follow-ups), 66 models, 9 migrations, 162 route files.
- Tests: 132 files, 1788 passing; typecheck, lint, i18n check, build and 9 e2e specs pass (`MILESTONE-2-3.md`).
- **Deferred**: every Phase 2/3 screen and the field app; providers (storage, geocoding, notification channels); a scheduler/worker; unauthenticated lead intake; a single end-to-end chain test.

## Phase 4 backend: financial core (done, no UI, formula-free)

- 6 more server modules (approvals, ledger, payments, materials, finance-adjustments, reconciliation), 80 models, 11 migrations,
  222 route files; Int money columns are BigInt. Whole-phase review in `reviews/phase4-review.md` (no Critical; Important fixed).
- **Compensation / commission formulas are BLOCKED** pending an approved compensation specification (spec 28.4).
- **Deferred**: payment provider (none configured), scheduler / worker, finance / materials / approvals UI, exports.

## Phase 5 backend: workforce intelligence (done, no UI)

- 7 more server modules (training, performance, coaching, data-challenges, development, development-dashboard, customer-feedback)
  plus self-service read models (`/api/v1/me/**`), 94 models, 13 migrations, 291 route files. Whole-phase review in
  `reviews/phase5-review.md` (no Critical; Important fixed). Performance data is development use only (spec 10.3, architecture tests).
- **Deferred**: survey provider, scheduler / worker (recomputation, sweeps, recommendation runs), every Phase 5 screen. Owner
  decisions in `MILESTONE-5.md` section 9.

## Not done / next

- **No notifier/email provider**: invitations and password resets cannot reach a real user.
- **No tenant provisioning** (seed only; `GET/PATCH /tenants/current`) and **no audit-log API/UI**.
- UI for Phase 2/3 and the React Native field app (the `/api/v1` and field-sync contracts are ready).
- **Compensation, commission and employee statements are blocked** on an approved compensation spec (spec 28.4); the rest of
  Phase 4 is built (`MILESTONE-4.md`), and its owner decisions are listed there (section 9).
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
