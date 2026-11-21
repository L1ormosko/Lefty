# Project state

Last updated: Task 1 (scaffold + Phase 0 docs + core schema).

## Done

- Project scaffold in `leadro/` (Next.js 15, React 19, strict TS, Prisma 6, Vitest, Tailwind 3, ESLint).
- Local Postgres role/DBs script (`scripts/setup-db.sh`).
- Prisma schema for Organization, Identity and Access, and Platform subset (19 models).
- Migrations: `init` (generated) and `rls_and_constraints` (hand-written): FORCE RLS on all tenant-owned
  tables, append-only `AuditEvent`, org tree integrity, effective-date and scope CHECKs.
- `src/server/db`: `prisma`, `withTenant`.
- Permission catalog + seed.
- Phase 0 docs: ARCHITECTURE, ERD, PERMISSIONS, API_CONVENTIONS, DECISIONS.
- Integration tests: RLS isolation (read/insert/update/delete, fail-closed, no context leak), RLS
  coverage sweep, composite-FK tenant integrity, audit append-only, org/assignment/scope constraints.

## Not done / next

- Auth (local credentials, sessions, lockout, invitations, password reset, MFA) - next tasks.
- Authorization service (effective permissions + scope resolution), default role templates seeding.
- Organization / people CRUD, audit helper, request pipeline helpers, i18n catalog + RTL UI shell.
- Customers, leads, jobs, dispatch, field app, etc. (later phases). Finance/compensation blocked on an
  approved compensation spec (spec 28.4).

## Known limitations / open items

- Audit append-only is trigger-based; a table owner can still drop the trigger. Production hardening
  (separate DDL owner vs. runtime role, REVOKE) is not done.
- Role templates not in the 4.5 matrix are derived (DECISIONS 23); needs confirmation.
- `RolePermission.conditions` vocabulary undefined until consuming modules exist.
- No claim of security review, compliance, or production readiness (spec 28.7).
