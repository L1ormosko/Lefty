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
- **Legal** — `/takanon` (platform rules), `/terms` (user agreement), `/privacy`
  (privacy policy), all real content, cross-linked, with a site footer
  (legal links + support contact) on every page except the map shell.
- **Account recovery** — full forgot/reset-password flow: a rate-limited,
  enumeration-safe request step and a token-gated reset that invalidates
  every existing session on success.
- **Registration consent** — accepting the terms/privacy is a required
  checkbox, timestamped on the user record (`termsAcceptedAt`).

## Guarantees worth knowing
- Overlapping approved bookings are impossible: a partial GiST exclusion
  constraint enforces it in Postgres. Tested with two concurrent approvals.
- Every mutation passes an ownership loader before any write.
- Unknown data renders as "לא צוין"; nothing invents prices, audiences or
  verification. Seed rows carry `isDemo` and are labelled in the UI.
- A public asset page and an approved booking both surface real contact
  info between the two parties (company-level, never a personal phone/email
  outside a direct inquiry) — the "who do I actually talk to" gap a launch
  audit found is closed.
- An asset cannot be published without at least one photo.
- A media owner's subscription can block *publishing another* listing, and
  nothing else. A lapse never deactivates live inventory, and an account with
  no plan row is unlimited. Lapse is derived at read time - there is no
  scheduler here, and a stored flag would be wrong most of the time it
  mattered. VELTO issues no invoices and takes no payment: `OwnerPlan`
  references an invoice raised in approved bookkeeping software.
- The creative preview is a flat projective overlay on a photo whose sign face
  an admin has marked, labelled "הדמיה בלבד — לא צילום של הפרסום בפועל". With
  no marked face the feature is not offered rather than guessed at. The
  advertiser's artwork never leaves their browser - no upload, nothing stored -
  and an e2e test watches for any non-GET request while a file is chosen.

## Tests
226 Vitest tests (unit + integration) and 75 Playwright journeys across desktop
and mobile viewports. All green.

The Vitest environment is `node` only - no jsdom - so components cannot be
unit-tested. Logic that needs testing lives in pure modules instead
(`lib/plan.ts`, `lib/mockup.ts`, `components/map/filters.ts`,
`components/map/sheet.ts`), and the browser behaviour on top of them is covered
by Playwright.

## Running the suites locally
`bash scripts/dev-up.sh` first. Postgres and the dev server are both reclaimed
mid-session in the dev container, and a suite run against a dead server fails
in a way that looks exactly like a code regression - a whole suite red,
including specs the change never touched. Note also that `npm run build` writes
to the same `.next` directory `next dev` is serving from, so a build while the
dev server is up corrupts it: restart the dev server after building.

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
- Email delivery code exists (`server/email.ts`, Resend via `fetch`) and is
  wired into every notification and password reset, but no-ops with a
  console warning until `RESEND_API_KEY`/`EMAIL_FROM` are set - see TODO.md.
- The rate limiter is in-process, which is correct for one instance only.
- Uploads go to local disk; swapping to object storage touches one route.
- English strings exist as a scaffold, not a translation.
- The three legal documents are an honest first draft grounded in the actual
  schema and flows - they are not a substitute for a lawyer's review.

## Costs
See `COSTS.md`: a monthly infrastructure estimate, an order-of-magnitude
estimate for this build session's Claude usage, and a recommended pricing
model sequence (lead/listing fee now, commission once payments exist).

## Next action
Pick from TODO.md — the top item is a commercial tile provider key, which is the
only thing standing between this and a demo in front of a real advertiser.
The "Before real customers" section covers the non-technical launch gaps
(legal, business registration, support contact).
