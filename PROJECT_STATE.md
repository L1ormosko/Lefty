# VELTO — Project state

**Phase:** MVP complete end-to-end. Phases 0–7 done.

## Stack
Next.js 15 (App Router, server components + server actions) · TypeScript ·
Prisma 6 + PostgreSQL 16 · Tailwind 3 · MapLibre GL 4 · Zod · Vitest ·
Playwright. One application, one database.

## What works, against the real backend
- **Landing (`/`)** — marketing page: hero with both primary CTAs, how-it-works
  for advertisers and owners, a trust section using the real verification and
  availability badges, live count of cities with active inventory.
- **Discovery (`/explore`)** — map of Israel opening on Be'er Sheva, clustered
  markers coloured and glyph-labelled by derived availability, bounding-box
  queries, URL-synced filters (city, type, dates, price, digital, verified
  only), desktop filter rail + results column, mobile bottom sheet + filter
  dialog.
- **Asset page** — hero, verification and availability badges, location map,
  specifications, commercial terms, declared availability windows, save,
  and a request panel (availability / quote / booking).
- **Advertiser** — register, login, requests, bookings, saved assets,
  notifications, profile.
- **Media owner** — seven-step asset wizard with draft autosave, map location
  picker, image upload, pricing, availability windows, inquiry replies,
  booking approve/reject.
- **Admin** — verification queue (approve / reject with note / deactivate),
  users (deactivate, which also kills sessions), inquiries, bookings, and a
  business overview: 30-day growth, the full verification funnel, company
  split by type, top cities by active inventory, and an informational
  open-bookings pipeline estimate.
- **Media owner overview** — same pipeline-estimate figure scoped to the
  owner's own assets, and a per-asset booking count alongside inquiries/images.

## Guarantees worth knowing
- Overlapping approved bookings are impossible: a partial GiST exclusion
  constraint enforces it in Postgres. Tested with two concurrent approvals.
- Every mutation passes an ownership loader before any write.
- Unknown data renders as "לא צוין"; nothing invents prices, audiences or
  verification. Seed rows carry `isDemo` and are labelled in the UI.

## Tests
54 Vitest tests (unit + integration) and 18 Playwright journeys (added a
landing-page smoke test) across desktop and mobile viewports. All green.

## Final UX pass
A value-proposition headline sits above the map (the map still owns the screen),
the mobile search row no longer squeezes the filter button, the wizard's first
button reads as progress, and assets without a photograph show a neutral
placeholder. We do not substitute stock photography for a missing image: an
advertiser has to be able to tell a space they have seen from one they have not.

## Known limitations
- The default map style uses keyless OpenStreetMap tiles; production needs a
  commercial provider via `NEXT_PUBLIC_MAP_STYLE_URL`. (In the build sandbox,
  tile hosts are blocked by network policy, so screenshots show markers over an
  empty basemap — the app handles that with a visible notice.)
- Notifications are in-app only; `notify()` is the single hook for email.
- The rate limiter is in-process, which is correct for one instance only.
- Uploads go to local disk; swapping to object storage touches one route.
- English strings exist as a scaffold, not a translation.

## Costs
See `COSTS.md`: a monthly infrastructure estimate, an order-of-magnitude
estimate for this build session's Claude usage, and a recommended pricing
model sequence (lead/listing fee now, commission once payments exist).

## Next action
Pick from TODO.md — the top item is a commercial tile provider key, which is the
only thing standing between this and a demo in front of a real advertiser.
The "Before real customers" section covers the non-technical launch gaps
(legal, business registration, support contact).
