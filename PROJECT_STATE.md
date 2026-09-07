# VELTO — Project state

**Phase:** 2 complete (foundation) → 3 (map / discovery) in progress.

## Stack
Next.js 15 (App Router, RSC) · TypeScript · Prisma 6 + PostgreSQL 16 · Tailwind 3 ·
MapLibre GL 4 · Zod · bcryptjs sessions · Vitest + Playwright.
Single application, single database. No microservices.

## Done
- Prisma schema + migration, including hand-written SQL: CHECK constraints and the
  GiST exclusion constraint that makes double-booking impossible at the DB level.
- Domain layer: constants (all enums centralised), Hebrew label dictionary (`t()`),
  date helpers, derived availability logic, price estimation.
- Auth: bcrypt(12), 256-bit session token stored as sha256, HttpOnly cookie,
  login rate limiting, timing-safe unknown-email path.
- Authorization: `requireUser` / `requireRole` + `loadOwned*` gates.
- Public asset queries with bbox + filters; booking service with conflict handling.
- Development seed: 4 users, 16 demo assets (11 Be'er Sheva + 5 elsewhere), all `isDemo`.

## Current task
UI: root layout (RTL), map discovery page, asset detail.

## Local development
    service postgresql start
    npm install && npx prisma migrate dev && npm run seed:dev && npm run dev
Dev logins are printed by `npm run seed:dev` (local development only).

## Notes that matter
- Availability is derived from AvailabilityPeriod minus APPROVED bookings — never stored.
- Every demo record has `isDemo: true` and is labelled in the UI.
- Unknown data renders as "לא צוין" — the product never invents inventory or prices.
