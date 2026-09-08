# Architecture

One Next.js application, one PostgreSQL database.

    Browser (React, MapLibre GL)
        │  server actions + /api routes
    Next.js 15 App Router (server components)
        │  Prisma
    PostgreSQL 16

## Layout

    src/lib/        pure domain code, safe on client and server
      constants.ts    every enum and map default, single source of truth
      labels.ts       t() + the Hebrew dictionary (en scaffolded)
      dates.ts        inclusive UTC day ranges
      availability.ts derived availability + price estimation
      validation.ts   zod schemas for every network boundary
      map-style.ts    tile style selection
    src/server/     server-only: database, auth, authorization, services
      db.ts           Prisma client singleton
      auth.ts         sessions, login, requireUser / requireRole
      authz.ts        loadOwnedAsset / loadOwnInquiry / loadOwnBooking
      assets.ts       public inventory queries (bbox + filters)
      bookings.ts     request creation, approval, conflict handling
      notifications.ts in-app notifications
      errors.ts       AppError hierarchy; users never see database errors
      rate-limit.ts   fixed-window limiter
    src/app/        routes; actions/ holds every server action
    src/components/ UI, grouped by area (map/, owner/, admin/, request/)

## Data model

    Company ──< User ──< Session
                 │
                 ├──< MediaAsset ──< MediaAssetImage
                 │         ├──< AvailabilityPeriod
                 │         ├──< Inquiry ──< Booking
                 │         └──< SavedAsset
                 ├──< Inquiry
                 ├──< Booking
                 ├──< SavedAsset
                 └──< Notification

Verification lives on `MediaAsset` (`verificationStatus`, `verifiedAt`,
`verifiedById`, `reviewNote`). Availability is not a column: it is derived from
`AvailabilityPeriod` minus `APPROVED` `Booking` rows for the requested window.

Constraints beyond Prisma's reach are in the initial migration's SQL: coordinate
and price range CHECKs, date-order CHECKs, and the GiST exclusion constraint
that makes overlapping approved bookings impossible.

## Authentication and authorization

Session cookie → `Session.tokenHash` → user. `requireUser()` / `requireRole()`
guard the entry of every action and protected route; `loadOwned*()` guards every
mutation by ownership. Route group layouts (`/dashboard`, `/owner`, `/admin`)
redirect the wrong role, but they are not the security boundary.

## Maps

MapLibre GL. One `MapView` component serves the discovery map, the asset
location map and the owner's location picker. Assets reach it as clustered
GeoJSON; the source data is refetched from `/api/assets` on viewport change,
debounced, with the current filters.

## Storage

Uploaded images are re-encoded to WebP by `sharp` and stored as bytes in
Postgres. `MediaAssetImage` holds the metadata (url, dimensions, size, order)
and `MediaAssetImageBlob` holds the bytes in a separate table, so the map and
asset-page queries that `include` images never pull image data into memory.
`src/app/api/images/[id]` serves them; `src/server/storage.ts` is the only
module that knows where they live.

They were previously written to `public/uploads` on local disk. That is fatal
on a host with an ephemeral filesystem: every deploy erased every photo while
the rows survived, so listings pointed at 404s. Postgres was chosen because it
is already the backed-up source of truth; the trade is a ceiling of roughly 250
fully photographed assets per GB, at which point `storage.ts` is swapped for
object storage and `prisma/backfill-image-blobs.ts` shows the shape of the
migration.

## Accounts and personal data

`src/server/account.ts` implements the three rights `/privacy` promises:
`exportUserData` (see), the profile forms (correct), and `anonymizeUser`
(erase). Erasure keeps the rows and destroys the identity - see DECISIONS.md
§15 for why deleting them would have taken the counterparty's records with it.

## Deployment

Needs a Node runtime (`sharp` rules out a pure edge deployment) and a
PostgreSQL database. No writable filesystem is required. `npm run build` runs `prisma generate`;
apply migrations with `prisma migrate deploy`. Required environment variables
are listed in `.env.example`.

## Testing

- `npm test` — Vitest. Unit tests for availability, pricing and dates;
  integration tests against the real database for booking conflicts (including a
  concurrent double-approval race), authorization, auth, and the map query.
- `npm run test:e2e` — Playwright. Advertiser, media owner and admin journeys on
  desktop and mobile viewports.
