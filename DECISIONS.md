# Decisions

Only decisions that would be expensive to reverse, or that a future maintainer
would otherwise re-litigate.

## 1. Stack: Next.js 15 (App Router) + Prisma + PostgreSQL, one application

A single full-stack monolith with server components and server actions. No
separate API service, no microservices, no client-side state library. The
product is a database-backed marketplace with a map on top; anything more is
weight the MVP would carry without using.

Versions are pinned one major behind the newest releases (Next 15, React 19,
Tailwind 3, Prisma 6). Boring and well-documented beats newest.

## 2. Availability is derived, never stored

`asset.status = "available"` cannot answer "is this billboard free in March".
Availability is computed at query time from owner-declared `AvailabilityPeriod`
rows minus `APPROVED` bookings, for the specific window the advertiser asked
about. This is why the map answers date filters truthfully.

## 3. Double-booking is prevented by the database, not by application code

A partial GiST exclusion constraint on `Booking`:

    EXCLUDE USING gist ("assetId" WITH =, daterange("startDate","endDate",'[]') WITH &&)
      WHERE (status = 'APPROVED')

Application code also checks for conflicts, but only to produce a friendly
message. The constraint is what holds under concurrency, under a second app
instance, and under any future background job. An integration test approves two
overlapping bookings simultaneously and asserts that exactly one succeeds.

Rejected alternatives: SERIALIZABLE isolation (needs retry loops on every write
path touching bookings) and advisory locks alone (easy to forget at a new call
site; the database would not stop you).

## 4. Custom session auth rather than an auth library

Email + password with bcrypt (cost 12), a 256-bit random session token stored in
the database as its SHA-256 hash, and an HttpOnly / SameSite=Lax / Secure
cookie. Logout deletes the row. Login is rate limited per account and per IP and
always runs a bcrypt comparison, so an unknown email is not distinguishable by
timing.

NextAuth v4 is Pages-Router shaped and v5 was beta; for three roles and one
credential type, ~120 lines we fully control is less risk than an adapter we do
not. Not built: refresh-token rotation, device fingerprinting, MFA, "log out
other devices" — none of these change whether the MVP is safe to run.

## 5. Authorization goes through loader functions

Mutations never call `prisma.<model>.update({ where: { id } })` with a
user-supplied id. They call `loadOwnedAsset` / `loadOwnInquiry` /
`loadOwnBooking` first, which throw `NotFoundError` or `ForbiddenError` before
any write. Route-level guards exist too, but they are defence in depth, not the
boundary. Tests assert that a second media owner cannot load another owner's
asset.

## 6. MapLibre GL with a configurable style URL

Chosen over Google Maps and Mapbox: no API key required to develop, no per-load
billing, vector/raster agnostic, and Hebrew place names come from OpenStreetMap
data. `NEXT_PUBLIC_MAP_STYLE_URL` swaps in a commercial provider for production —
the default keyless OpenStreetMap raster style is fine for development but its
tile-usage policy does not permit production traffic.

Cluster counts are rendered as DOM labels, not a MapLibre `symbol` layer,
because a symbol layer requires a glyph endpoint the keyless style has none of.
Individual assets stay on the GPU circle layer, so the map remains cheap at
thousands of points; only visible clusters get a DOM node.

## 7. Client-side clustering over a bounding-box query

The `/api/assets` endpoint filters by viewport bounding box server-side and
returns a minimal projection (no descriptions, no image lists). MapLibre's
built-in clustering handles the rest. Server-side clustering and PostGIS are
both deferred: with a few thousand assets, a composite btree index on
`(status, latitude, longitude)` is enough, and PostGIS is a schema commitment
that would not pay for itself yet.

## 8. Images are re-encoded, never stored as uploaded

`sharp` decodes the upload and re-encodes it to WebP. This proves the bytes are
really an image, strips EXIF and any embedded payload, and normalises format.
Filenames are server-generated UUIDs, so no user input reaches a filesystem
path. SVG is rejected outright (it can carry script). Size, dimension and
per-user rate limits cap the DoS surface.

Local disk under `public/uploads` is deliberate for the MVP; the upload route is
the only writer, so moving to object storage later touches one file.

## 9. Three request intents, one entity

Availability check, quote request and booking request are one `Inquiry` with an
`intent` field, not three flows. A `BOOKING` intent additionally creates a
`Booking` in `REQUESTED` state so the owner has something to approve. The UX
review argued for collapsing to a single CTA; the data model collapse gives the
same simplicity without losing the distinction the owner needs when replying.

Rejected: a timed "hold" on dates with a countdown. It changes the commercial
promise of the platform and needs expiry infrastructure. Not an MVP problem.

## 10. Honesty rules encoded in the data model

Every price, dimension and permit field is nullable and renders as
"לא צוין" when absent. `verificationStatus` is a first-class enum with a visible
badge, and an unverified asset says so on the card, on the map and on its page.
`permitStatus` defaults to `UNKNOWN` and carries a disclaimer — VELTO does not
assert that a sign is legally permitted. Seed records carry `isDemo` and are
labelled in the UI as development data. There is no impressions, audience or
traffic field anywhere, because we have no source for those numbers.

## 11. Deferred, with the extension point noted

- **Digital OOH slots.** A digital screen is currently bookable inventory like
  any other. The future model (screen → loop → slot → plays) fits underneath
  `MediaAsset` as a child table without changing the booking flow.
- **Payments and commission.** `Booking.priceEstimate` exists; a payment record
  would reference a booking. Nothing in the schema assumes free bookings.
- **Email notifications.** `notify()` is the single call site for every event,
  so adding a provider is one function body.
- **English UI.** All strings go through `t()` against a dictionary keyed by
  locale. The `en` dictionary exists and falls back to Hebrew per key.
- **Campaign entity.** Inquiries carry a `campaignName` string. A campaign
  grouping several assets is a future table, not an MVP one.

## 12. What was cut, and why

- Advanced analytics, a bidding system, messaging, and a campaign planner: none
  of them are needed to prove that advertisers will search for and request
  outdoor inventory.
- Separate "verification" and "campaign" tables from the original sketch:
  verification is three fields on the asset (`verificationStatus`, `verifiedAt`,
  `verifiedById`, plus `reviewNote`), which is the whole workflow admin needs.
