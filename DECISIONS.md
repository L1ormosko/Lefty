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

Where those bytes are kept is decision 14.

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

## 13. The landing page counts real inventory only

Two reviewers disagreed on the landing page's proof-of-life element. The design
review wanted a city-coverage strip with counts, as the one concrete piece of
evidence on an otherwise text-only page. The product review flagged the same
element as the riskiest line on the page: every seeded row carries `isDemo`,
so a count drawn from them presents demo data as a live marketplace.

Data integrity wins over polish, but the visual idea survives intact.
`realInventorySummary()` (src/server/assets.ts) counts only `ACTIVE` rows with
`isDemo: false`. When that is zero - which is the case today - the hero states
plainly that VELTO is in pilot and that the map currently shows demo listings.
The coverage strip renders the moment real inventory exists, with numbers that
are true on the day they appear. An E2E test asserts the invariant against the
database rather than against fixture assumptions.

The same rule killed the hero mock-up's contents: the sample cards carry the
real availability and verification badges over neutral placeholder bars, not
invented cities and prices. The page shows what the interface looks like
without asserting that any particular space exists at any particular price.

## 14. Image bytes live in Postgres, not on disk

Uploads were written to `public/uploads`. On a host with an ephemeral
filesystem that is silently destructive: every deploy erased every photo a
media owner had ever uploaded, while the `MediaAssetImage` rows survived and
went on pointing at 404s. Publishing an asset requires at least one photo, so
listings passed validation and then quietly broke. The failure produced no
error anywhere - the only symptom was a broken picture on someone else's
screen.

The bytes now live in Postgres, the store that is already the backed-up source
of truth. Three consequences worth stating plainly:

- **A separate table.** `MediaAssetImageBlob` is 1:1 with `MediaAssetImage`
  rather than a column on it, because the map query and the asset page both
  `include` images. A `Bytes` column would have dragged megabytes into memory
  on every one of them. Nothing reads the blob table except the route that
  serves an image.
- **Deletion stopped leaking.** The disk implementation needed an `unlink`
  alongside every row delete, and `deleteAssetImageAction` did not have one, so
  each deleted photo leaked a file that nothing would ever reclaim. The cascade
  makes that unrepresentable, which is why `storage.ts` has no `deleteImage`.
- **A ceiling, named.** A WebP at 1920px/q82 runs 150-400KB, so a fully
  photographed asset is ~3MB and a 1GB database holds on the order of 250 of
  them. That is comfortable for the Be'er Sheva pilot and is not a
  national-scale answer. `src/server/storage.ts` is the only module that knows
  where bytes live; swapping it for R2 or S3 is a one-file change, and
  `prisma/backfill-image-blobs.ts` is the shape of the accompanying migration.

Serving is unauthenticated by image id, which is exactly what the previous
static `/uploads/<uuid>.webp` path was. This change deliberately moved storage
and nothing else: folding an authorization change into it would have left
neither properly reviewed. Tightening it is tracked in TODO.md.

## 15. Erasure means anonymization, and the two traps that forced it

`/privacy` promises three rights: to see the data we hold, to correct it, and
to have it erased. None of them existed in the product. That is worse than not
promising them, so it was P0.

The obvious implementation - delete the `User` row and let the cascades do the
rest - is wrong twice over, and the schema is what says so:

- **`Inquiry` keeps its own copy of the contact details.** `contactName`,
  `contactEmail` and `contactPhone` are snapshotted onto every inquiry. Deleting
  the user row alone would have left the person's name, email and phone sitting
  in every inquiry they ever sent: an erasure that erases nothing, while
  reporting success.
- **`Inquiry` and `Booking` cascade from `User`.** A booking is a record of two
  parties. A hard delete would erase a media owner's approved bookings because
  the advertiser closed their account. For a media owner it is worse still:
  their `MediaAsset` rows cascade too, taking every advertiser's bookings on
  those assets with them.

So erasure destroys what is purely personal (sessions, saved assets,
notifications, reset tokens), overwrites every identifying field *wherever it is
stored* - the user row, the inquiry snapshots, and the free text the user wrote,
which can name people - and leaves the commercial records standing with nobody's
name on them. The tombstone email uses the `.invalid` TLD, reserved by RFC 2606,
so it can never collide with an address someone later registers.

Three consequences that are easy to miss and are covered by tests:

- A departing media owner's assets are set `INACTIVE`, not deleted. That takes
  them off the map immediately (and `getPublicAsset` already refuses to serve a
  non-ACTIVE asset's company contact details) without destroying other people's
  bookings.
- If the leaving user is the last member of their company, the company's
  contact email and phone are cleared too: for a sole trader those *are* the
  person's own details, published on every asset page. With other members still
  in the company they are left alone, because wiping them would be erasing
  someone else's data.
- Deletion is refused while an approved booking has not ended, in either
  direction. Walking away mid-commitment leaves the counterparty holding a
  booked space with nobody to contact.

Not built: a grace period before the erasure takes effect. It needs a scheduled
job, which the current hosting plan does not have, and a deletion that silently
does not happen yet would be its own kind of dishonesty.

## 16. Seed credentials come from the environment, and missing means failure

The deploy's build command ends with `npm run seed:dev`, so `prisma/seed.ts`
runs against the production database on every deploy and creates
`admin@velto.dev`. Its password was a constant in that file. The repository is
public. Those two facts together meant a working ADMIN login for the live site
was published on GitHub - able to verify and reject assets and to deactivate
users - for as long as both were true.

The fix is small; the reasoning worth keeping is about the failure mode:

- **No default.** `requireSeedPassword()` throws when `SEED_PASSWORD` is unset.
  The tempting alternative - fall back to a built-in value - is precisely how
  the hole returns, silently, the first time someone deploys without the
  variable set.
- **Fail loudly, do not skip.** A seed that quietly no-ops on missing config
  would leave an empty database and no signal. A failed deploy is far cheaper
  than an exposed admin account, so the seed exits non-zero.
- **A length floor.** 24 characters, so the variable cannot be satisfied with
  something typed in a hurry.
- **The password is never printed.** The old seed echoed it to stdout. Build
  logs are retained and readable in the hosting dashboard, so logging the
  credential would undo half the point of moving it out of the file.
- **`SEED_DEMO` gates the whole thing**, defaulting to off. Turning the demo
  off for a real launch is now one environment variable rather than a code
  change - which matters because this seed deletes and recreates the demo rows
  every time it runs.

The guard is unit-tested against an injected environment rather than by
mutating `process.env`. That is not fussiness: Prisma's client loads `.env` on
import, so an early manual check of the "missing password" case passed when it
should have failed. The test takes the environment as an argument so it cannot
be fooled the same way.
