# VELTO — Project state

**Phase:** MVP complete end-to-end. Phases 0–7 done.

## Stack
Next.js 15 (App Router, server components + server actions) · TypeScript ·
Prisma 6 + PostgreSQL 16 · Tailwind 3 · MapLibre GL 4 · Zod · Vitest ·
Playwright. One application, one database.

## What works, against the real backend
- **Discovery** — map of Israel opening on Be'er Sheva, clustered markers
  coloured and glyph-labelled by derived availability, bounding-box queries,
  URL-synced filters (city, type, dates, price, digital, verified only),
  desktop filter rail + results column, mobile bottom sheet + filter dialog.
- **Asset page** — hero, verification and availability badges, location map,
  specifications, commercial terms, declared availability windows, save,
  and a request panel (availability / quote / booking).
- **Advertiser** — register, login, requests, bookings, saved assets,
  notifications, profile.
- **Media owner** — seven-step asset wizard with draft autosave, map location
  picker, image upload, pricing, availability windows, inquiry replies,
  booking approve/reject.
- **Admin** — verification queue (approve / reject with note / deactivate),
  users (deactivate, which also kills sessions), inquiries, bookings.

## Guarantees worth knowing
- Overlapping approved bookings are impossible: a partial GiST exclusion
  constraint enforces it in Postgres. Tested with two concurrent approvals.
- Every mutation passes an ownership loader before any write.
- Unknown data renders as "לא צוין"; nothing invents prices, audiences or
  verification. Seed rows carry `isDemo` and are labelled in the UI.

## Tests
54 Vitest tests (unit + integration) and 14 Playwright journeys across desktop
and mobile viewports. All green.

## Known limitations
- The default map style uses keyless OpenStreetMap tiles; production needs a
  commercial provider via `NEXT_PUBLIC_MAP_STYLE_URL`. (In the build sandbox,
  tile hosts are blocked by network policy, so screenshots show markers over an
  empty basemap — the app handles that with a visible notice.)
- Notifications are in-app only; `notify()` is the single hook for email.
- The rate limiter is in-process, which is correct for one instance only.
- Uploads go to local disk; swapping to object storage touches one route.
- English strings exist as a scaffold, not a translation.

## Next action
Pick from TODO.md — the top item is a commercial tile provider key, which is the
only thing standing between this and a demo in front of a real advertiser.
