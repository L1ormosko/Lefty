# LEADRO

Enterprise multi-tenant field-operations platform (see `docs/SPEC.md`, the binding product spec).
This is a self-contained application: it shares nothing with the VELTO app at the repository root.

Status: Milestone 1 (Phase 0 architecture + Phase 1 platform foundation) is implemented and tested;
see `docs/MILESTONE-1.md` for what exists, what does not, and the known limitations, and
`docs/PROJECT_STATE.md` for the short status. Not production-ready; no security or legal-compliance
claims are made (spec 28.7).

## Stack

Next.js 15 (App Router) + React 19 + TypeScript (strict) + Prisma 6 + PostgreSQL 16 + Zod +
Vitest + Tailwind 3. Versions are pinned exactly in `package.json`.

## Local setup

```bash
# 1. PostgreSQL 16 running locally (e.g. `service postgresql start`).
# 2. Create the app role + databases (idempotent; needs superuser via `sudo -u postgres psql`):
./scripts/setup-db.sh
# 3. Install, configure, migrate, seed:
npm install
cp .env.example .env
npm run db:deploy        # apply migrations to the dev database `leadro`
SEED_PASSWORD="<16+ chars, your choice>" npm run seed   # catalog + two demo tenants (see below)
npm run dev
```

### What `scripts/setup-db.sh` does (manual equivalent)

```sql
CREATE ROLE leadro LOGIN PASSWORD 'leadro' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE leadro      OWNER leadro;
CREATE DATABASE leadro_test OWNER leadro;
```

The app role is **not** a superuser and has **no** `BYPASSRLS`, so row-level security always
applies. Because it owns the tables, the policies use `FORCE ROW LEVEL SECURITY`. `CREATEDB` is
there only so `prisma migrate dev` can create its shadow database.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `prisma generate` + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest; integration tests run against `leadro_test` |
| `npm run db:migrate` | `prisma migrate dev` (create/apply migrations in development) |
| `npm run db:deploy` | `prisma migrate deploy` on the dev database |
| `npm run db:migrate:test` | `prisma migrate deploy` on `leadro_test` (also done automatically by `npm test`) |
| `npm run i18n:check` | Verifies every translation catalog has the same keys and placeholders |
| `npm run seed` | Dev seed: permission catalog + two demo tenants; needs `SEED_PASSWORD` (>= 16 chars, never printed), refuses in production |

## Development seed

`SEED_PASSWORD=... npm run seed` creates (idempotently, by company code) two fictional tenants, `acme-field` and
`globex-home`, each with two legal entities, Texas/Florida/California, regions, cities, branches, teams and one ACTIVE
user per role template (`owner@acme-field.example.test`, `city-manager@...`, `technician@...`, ...). Every user signs in
with the company code, the email and `SEED_PASSWORD` (there is no default password; the value is hashed and never
printed). The Owner/CEO, COO, Finance Director and HR Manager roles require MFA (as does any role that can manage
permissions or configure a module), so set `LEADRO_ENCRYPTION_KEY` and enroll an authenticator on first
login. Log in to one tenant and confirm you never see the other: that is the isolation check by hand.

## Tests

`npm test` first applies pending migrations to `leadro_test` (forward-only `migrate deploy`), then
runs the suite. Tests create uniquely named tenants and never assume an empty database. The test
setup refuses to run against a database whose name does not end in `_test`.

### Resetting the test database

Only needed if an already-applied migration was edited. This destroys all data in `leadro_test`
(a throw-away database), so it is a manual step:

```bash
sudo -u postgres psql -c 'DROP DATABASE leadro_test' && sudo -u postgres psql -c 'CREATE DATABASE leadro_test OWNER leadro'
npm run db:migrate:test
```

## Layout

```
prisma/            schema, migrations (init + hand-written RLS/constraints), seed
src/server/<module>/   server modules; other modules import only through index.ts
src/server/db/     `prisma` client and `withTenant(tenantId, fn)`
src/server/       modules: auth, authz, organization, employees, users, roles, audit, i18n, core, logging, db
src/app/           Next.js UI (login/MFA/account screens, administration screens) and /api/v1 route handlers
src/components/ui  shared UI components;  src/lib: pure shared code (i18n catalogs, TOTP, redaction)
scripts/           setup-db.sh, i18n-check.ts
tests/             Vitest (service, route and UI-action tests hit the real database)
docs/              SPEC.md, ARCHITECTURE, ERD, PERMISSIONS, API_CONVENTIONS, CODING_STANDARDS, AUTH, AUTHZ,
                   DECISIONS, PROJECT_STATE, MILESTONE-1
```
