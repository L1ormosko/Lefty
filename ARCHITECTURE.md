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

Uploaded images are re-encoded to WebP by `sharp` and written to
`public/uploads` with generated UUID filenames. `MediaAssetImage` stores the
public path plus dimensions and size.

## Deployment

Needs a Node runtime (sharp and the filesystem writes rule out a pure edge
deployment), a PostgreSQL database, and a writable uploads directory or an
object-storage swap in the upload route. `npm run build` runs `prisma generate`;
apply migrations with `prisma migrate deploy`. Required environment variables
are listed in `.env.example`.

## Testing

- `npm test` — Vitest. Unit tests for availability, pricing and dates;
  integration tests against the real database for booking conflicts (including a
  concurrent double-approval race), authorization, auth, and the map query.
- `npm run test:e2e` — Playwright. Advertiser, media owner and admin journeys on
  desktop and mobile viewports.
