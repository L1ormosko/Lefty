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

## 17. The backup goes out through the app, not `pg_dump`

The hosted database is on a free plan: no backups, and the instance is deleted
on 2026-10-07. Copying the data out is therefore not a nice-to-have, and the
obvious tool does not work here.

`pg_dump` needs a connection. The instance's IP allow-list is empty, which
means it accepts no external connections at all — not from a laptop, not from
anywhere. The alternative, dumping from inside the running container, produces
a file on an ephemeral disk with no way to download it. What is left is the one
path that works from a browser with nothing installed: an admin-only route that
serializes the database and returns it as an attachment.

The consequences worth keeping:

- **Admin-only, and that is the whole security story.** The response is every
  user's personal data and password hashes in one object. `requireRole("ADMIN")`
  guards it, and the rate limit is deliberately tight (5/hour): nobody needs
  more, and a stolen admin session should not be able to pull the database
  repeatedly. The filename says `SENSITIVE` because that is the only warning
  still attached to the file once it is sitting in a downloads folder.
- **Sessions and password-reset tokens are excluded.** Both are transient
  authentication material. Restoring live sessions into a new database would be
  a security bug wearing a backup's clothes; everyone signing in again is the
  correct outcome, and the restore script says so when it finishes.
- **Password hashes are included.** A restore that forced a password reset on
  every user would not really be a backup. They are bcrypt hashes rather than
  passwords — which is why the file is sensitive rather than catastrophic.
- **Image bytes are included, as base64.** Counts can match while every image
  restores blank, so this is what makes it a whole backup rather than half of
  one. It is also the limit: the object is built in memory, so past roughly a
  few hundred photographed assets this needs replacing with a real `pg_dump`
  against a database that permits external connections. Same ceiling as §14.
- **`src/lib/backup.ts` is separate from `src/server/backup.ts`.** The shared
  table list has to be readable by both the route and the `tsx` restore script,
  and a `server-only` module cannot be imported from a script — verified, not
  assumed: it fails with "Cannot find module 'server-only'". Restore walks that
  shared list, so a table added to the export but not to the list shows up as a
  missing line rather than vanishing quietly.
- **A restore is all-or-nothing.** One transaction, rows in foreign-key order,
  and it refuses a database that already has users unless forced. A
  half-restored database is worse than an empty one, because it looks like it
  worked.

## 18. The brief: a matcher that cannot invent, and a model that cannot decide

Until now VELTO was a catalogue with a map. That is a directory, and an
advertiser can get a directory from a phone call. The value we actually hold is
the calendar: we know when every listed asset is free, and when the contract on
it ends. `/brief` is that value made usable - describe a campaign, get a ranked
shortlist of inventory that exists, with the reasoning shown.

Three decisions inside it are worth not re-litigating.

**The ranking is computed only from columns somebody filled in.** Availability
for the requested dates, the price the owner published, the type, the city, the
verification status, the presence of a photo, the surroundings the owner
declared. What is deliberately absent is any notion of audience: no impressions,
no traffic counts, no demographics, no "reach". We hold none of that data, and a
recommendation engine that produces such a number is producing fiction with a
ranking attached - which is precisely the failure the project's first rule
exists to prevent. A unit test asserts that two assets identical in every column
score identically, so no such term can be slipped in later without failing.

**What is missing is shown, not hidden.** Every result carries its gaps: no
published price, no dimensions, no photo, no declared surroundings, over the
stated budget. An asset with no price is neither dropped nor quietly assumed
affordable - it ranks below one that demonstrably fits, and says why. A
shortlist that only shows strengths is how an advertiser ends up discovering on
the phone that nobody ever published a rate.

**The language model is optional, and it cannot reach the inventory.** The free
text box is parsed by a model when `ANTHROPIC_API_KEY` is set and by a Hebrew
word-list parser when it is not, and the page states which one answered. The
contract with the model is narrow on purpose: it is given a sentence and asked
for a filter object - never the inventory, never a recommendation. Its answer is
then validated against our own enums and against the list of cities that
actually have assets, and anything invented is discarded rather than repaired: a
city we have no inventory in is not a near miss. Every failure path - no key, a
timeout, a non-JSON answer, a schema violation - falls back to the rules, so the
advertiser always gets a shortlist. That is the difference between an optional
enhancement and a dependency, and it is also why the feature could ship without
a paid key: a button labelled "AI" that does nothing without one would be the
fake feature this project does not build.

**Location tags are declared, never measured.** `LocationTag` is a list of
things an owner can see out of the window - a mall, a highway, a campus - not a
description of who passes by. The owner's form says VELTO measures nothing, and
every place a tag is rendered to an advertiser carries the same line. This is
the honest half of "target audience": we can say what is next to the billboard
because someone who owns it told us, and we cannot say who walks past it,
because nobody has counted.

The contract-expiry views (`src/server/expiring.ts`) are the same data seen from
two sides: the owner's renewal pipeline and the advertiser's "frees up soon".
Both are derived from APPROVED bookings. Note what is **not** claimed - whether
the current advertiser will renew. The end date is a fact; the renewal is not.

## A listing subscription, not a commission

VELTO's first revenue is a per-owner limit on how many listings can be public
at once, and the reason it is not a percentage of each deal is in the data.
`Booking.priceEstimate` is computed once from the owner's published list price,
is never updated, and is labelled "not a binding offer" everywhere it appears.
The last event VELTO observes is the owner pressing Approve — what is actually
signed, invoiced and paid happens off the platform. There is no number here
that anyone could honestly take a percentage of, and billing against a figure
we know to be an estimate would be inventing revenue data, which is the same
sin as inventing audience data.

Two rules constrain the whole feature, and both are in `lib/plan.ts`:

**No plan row means unlimited.** Every media owner on the platform today
predates billing. Adding a table must not silently put a cap on them.

**A lapse never takes live inventory down.** An advertiser who found a
billboard yesterday has to find it today. An unpaid invoice is between VELTO
and the owner; making the buyer pay for it would make the map unreliable, and
the map being reliable is the entire product. So a lapse blocks *adding* to
what is public — the two places an asset becomes ACTIVE — and nothing else.
Deactivating is always permitted: a subscription that could trap inventory in
the public map would be worse than no subscription.

The lapse is derived on every read rather than stored. This deployment has no
scheduler, and a `lapsed` column that only flips when a cron happens to run is
a column that is wrong during exactly the window that matters.

VELTO issues no invoices and moves no money. An Israeli tax invoice must be
issued from approved bookkeeping software, so `OwnerPlan.invoiceRef` is a
reference to a document that exists somewhere else, recorded by an admin by
hand. The owner's panel says so in as many words.

## The creative mockup is CSS, and it says what it is

An advertiser can preview their own artwork on a photograph of a real sign.
Three things make this safe to build.

**It is a projective transform, not a 3D model.** A billboard in a street photo
is a rectangle seen at an angle, so the artwork's parallel edges have to
converge the way the sign's do. Canvas 2D cannot do this — `setTransform` is
affine, and produces a skewed parallelogram that reads as a sticker. CSS
`matrix3d` can, because it is a full 4×4 homogeneous matrix and the browser
divides by w when it rasterises. The cost of the whole feature is one CSS
string per preview and four numbers per photo: no model, no rendered
composite, nothing uploaded. Gaussian splats (15–250MB per asset against a
~3MB budget) and AI-generated scenes were both considered and rejected; the
latter also runs into California AB 723, effective 1 January 2026.

**The artwork never leaves the browser.** It is read as an object URL, drawn
under the transform, and revoked when replaced. Unreleased campaign creative is
the most confidential thing an advertiser holds, and the safest way to hold it
is not to. An end-to-end test watches for any non-GET request while a file is
chosen.

**Without a marked face there is no preview.** An admin marks the sign's four
corners on one photo; a photo nobody has marked does not get the feature,
rather than getting a guessed rectangle with an ad on it that does not fit the
sign. The demo listings are all marked from the same constants their schematic
is drawn with (`demoSurfaceQuad`), so the face cannot drift away from the sign
in the picture.

That last point was learned the hard way. The seed originally marked one
listing of fifteen, and that one sorted last on `/explore` — so anybody opening
the first listing found no preview and reasonably concluded the feature had not
shipped. The end-to-end test walked every listing until it found the marked
one, so it passed the whole time: it proved the code worked without proving the
feature could be reached. The test now opens the first listing a visitor would
actually click and asserts the panel is there. The label above the picture — before it, not under it — reads
"הדמיה בלבד — לא צילום של הפרסום בפועל", and the limitations are stated:
a flat overlay, no relighting, no reflections, nothing passing in front.

## The sign's real size decides how the artwork sits

The creative preview mapped the advertiser's whole file onto the marked face,
which stretched it to whatever shape the sign was. A square logo on a 900x300
billboard rendered three times too wide - a picture of an advert that will
never exist, which is the same class of untruth as a wrong price, and the
listing's own `widthCm`/`heightCm` were sitting unused two fields away.

The fit now happens in the face's own coordinate space, using the physical
ratio from the listing rather than the quad's shape on screen. That distinction
matters: a sign photographed at an angle is foreshortened, so its on-screen
quad is not its real proportions, and comparing against it would give the wrong
answer for exactly the signs where perspective was the point.

A listing with no published dimensions fills the face as before - and says so.
There is no way to know a face's shape without its size, and "billboards are
usually 3:1" is a guess, which is the thing this product does not do.

The demo schematics are drawn from the same numbers, so a 3:1 billboard is
drawn 3:1 and a 0.4:1 totem tall and narrow. A picture of a sign in
proportions other than the ones being sold is a small lie told in advance.

## Street View sits beside the mockup, never underneath it

Asked to show how an advert looks "at the address", the tempting answer is to
paint it onto Street View. Google's terms forbid altering their imagery, and
call out alterations that misrepresent what the camera captured - which is
exactly what an advert composited onto their photograph of a street would be.
The exposure would be the operator's, not Google's.

So the surroundings come from two honest places instead. The advert is
previewed on photographs the owner supplied, and because `surfaceQuad` is per
image, an owner who uploads both a close-up and a wide street shot gives the
advertiser two real viewpoints of the same sign. Separately, an embedded and
unmodified Street View panel answers "what is actually on this corner",
carrying Google's own attribution, behind a key that leaves the panel absent
when it is not set.

## The map goes vague, not dark

Access to the inventory is what VELTO sells, so it sits behind an account: a
seven-day trial at registration, then a monthly subscription with a six-month
minimum term. Both sides pay - an advertiser for seeing the inventory, a media
owner for how much of it they may publish - and both live on one `Subscription`
row, because a company can be both.

What a visitor without access sees is the design decision worth recording. The
map does not go dark. They still see how many spaces exist and roughly where
they cluster, because a marketplace nobody can look into cannot attract the
side that pays to be in it. What they stop seeing is the exact position, the
price, the free dates, the street address and the owner's details - which is
precisely the part being sold.

The redaction happens on the server, in `redactForRestricted`, and is applied
in both places inventory reaches a browser: `/api/assets` and the
server-rendered first paint of `/explore`. Hiding a price with a CSS class or a
conditional in a component would leave the real number in the network tab; a
price that reaches the browser has been given away whatever the page paints.
The blurred position is produced by rounding rather than by adding noise, so
the same sign cannot be sampled repeatedly and averaged back to its true point.

Nothing here charges anyone. `paidThrough` is set by hand against an invoice
raised in approved bookkeeping software, exactly as the owner listing cap
already was. `committedUntil` records the agreed term because it is a fact
about the agreement, not because the application enforces it: collecting an
unpaid commitment is a matter between the parties, and a web application that
pretended otherwise would be lying about its own powers.

Trials are granted in the same statement that creates the user. Granting one
afterwards leaves a window in which a half-failed signup produces an account
with no access at all, and the person most likely to land in that window is the
one who just spent five minutes signing up.

## The paywall is a property of the query, not of the page

Three screens listed inventory and only one of them was careful. `/brief`
ranked the real inventory and handed an anonymous visitor the street address, a
priced estimate and the date each sign frees up. `/dashboard/saved` handed a
lapsed advertiser the same for everything they had bookmarked during their
trial. Both were written after the map's redaction and neither knew about it.

There was a subtler leak underneath. Blanking a price in the response does
nothing if the filter that selects on it still works: `maxPrice=4000` matching
a sign and `maxPrice=3999` not matching it states that sign's price to the
shekel, and a dozen requests do it for the whole map. The same trick reads the
address out of the free-text search one letter at a time and the calendar out
of a date range.

So the rule moved into `queryMap(q, { restricted })`, which strips the price,
date and availability filters and narrows free text to the city before building
the WHERE clause. Callers pass who is asking rather than remembering to
pre-filter. The map's filter panel hides the controls it knows are disarmed,
because a control that silently does nothing is a lie about the product - but
the UI is the second line, not the first.

What a viewer without access keeps is deliberate and unchanged: the type of
sign, the city, digital or not, and a position rounded to a neighbourhood. They
can see that there are eleven spaces in Be'er Sheva and roughly where they
cluster. That is the argument for signing up.

One detail worth keeping: the redacted title is the *type* of sign, not the
city. It was the city, which made a shortlist of ten read as ten identical
cards called "באר שבע" - correctly redacted and useless as a ranking.

## Holding a UUID is not permission

`/api/images/[id]` was reachable by anyone who knew the URL. That was inherited
honestly - it matched the static `/uploads/<uuid>.webp` path it replaced, and
the change that moved bytes into Postgres deliberately changed where images
were stored and nothing about who could read them, so that neither question was
reviewed by halves.

A UUID is an identifier, not a credential. It appears in server-rendered HTML,
in shared links, in browser history and in every proxy log on the way. Two
things leaked because of it: photographs of listings that were never public - a
draft, one the owner took down, one an admin rejected - and photographs of
public listings, which are part of what the subscription buys.

`server/images.ts` answers it once, from the asset the image belongs to. The
route 404s rather than 403s, because whether an image exists is itself a fact
about a listing that is not public. `Cache-Control` is `private` with `Vary:
Cookie`: a shared cache holding one of these would undo the check on the next
request.

## Storage is an interface, and Postgres is the stopgap behind it

Image bytes still live in Postgres, which holds roughly 250 fully photographed
assets per GB - a ceiling that arrives without warning. What changed is that
nothing outside `src/server/storage/` knows that. A `StorageProvider` has
`put`, `get` and an optional `remove`; `MediaAssetImage` records `storageKey`
and `storageProvider` per row.

Two rules are load-bearing. A key is opaque - callers persist it and never
parse it, because one store's key is a row id and another's is an object path.
And the URL is always ours: even once bytes sit in a bucket, the browser asks
`/api/images/[id]`, because that is where the authorization check lives. A
public bucket URL would hand every photograph to anyone who guessed a path,
which is precisely the hole above.

Reading resolves the provider *per row*, so a half-migrated database serves
every image: each row says where its own bytes are.

## The audit log must never break what it audits

`recordAudit` swallows its own failures and reports them to the server log, the
same way `server/email.ts` treats a missing provider. A booking that was
approved has been approved; rolling that back because an audit row would not
insert turns a bookkeeping problem into a commercial one.

The trade-off is explicit: this is a moderation and support aid, not a
tamper-proof ledger, and no guarantee in the product rests on it.

`actorId` is a nullable reference rather than a copy of the actor's email.
Accounts here are anonymized rather than deleted, so the reference still
resolves after erasure - and resolves to the anonymized identity, which is the
correct outcome. A snapshotted email would have quietly survived the erasure it
was supposed to respect.

## A request for dates that are already sold is refused at the door

`validateRequestWindow` checked the dates, the minimum booking length and that
the listing was public. It did not check whether any of those days were
actually for sale, so a request for a fortnight that an approved booking owned
outright was accepted, notified the owner, and sat in their queue as something
they could only ever reject - the overlap constraint would refuse the approval.

A window that is *partly* free is still allowed, deliberately. An advertiser
asking about 1-30 November when the 20th onward is taken is asking a reasonable
question, and the owner is the right person to answer it.

Availability windows gained the same treatment: a window that has already ended
is refused (it is almost always a mistyped year), and so is one that overlaps a
window the owner already declared. Overlapping periods are not wrong
arithmetically - `availabilityFor` unions them - but they are wrong as a
record: two rows saying "free in March" leave the owner unable to tell which
one a note belongs to, and deleting one appears to do nothing.

## Linting existed as a script and not as a check

`npm run lint` ran `next lint`, which found no configuration and offered to
create one interactively. There was no ESLint config in the repository and
`eslint` was not a dependency. So the script had never run - not in CI, not
locally - and "the build is clean" was being reported on a check that was
never performed.

It runs now, as flat config (ESLint 9 treats `.eslintrc` as legacy) with
`next/core-web-vitals` and `next/typescript`. Two rules are raised to errors
because both describe mistakes this codebase had actually made: unused
variables (one was a redaction helper that had stopped being called) and
`any` (which is how a Prisma type gets silently widened until it stops
catching what it was there to catch). Tests and seeds are exempt from the
`any` rule - they reach into partial shapes on purpose.

The first run found six errors and seven warnings, all real: five dead
imports and a dead helper, and four `react-hooks/exhaustive-deps` warnings in
the map. Those last were fixed structurally rather than suppressed - the three
"apply" functions read everything from refs, so they became `useCallback` with
empty dependency lists, which is both honest and stable enough to list in the
effects that call them.

## The maplibre advisory, and why the map is still on 4.7.1

`npm audit` had never been run either. It reports a critical advisory against
maplibre-gl: an XSS sanitizer bypass in the library's own `DOM.sanitize()`.

Reachability was checked before reacting. VELTO builds its popup content as an
HTML string, which is exactly the risky shape - but it escapes the two
owner-supplied fields (title, city) itself, before the string ever reaches
maplibre. The library's sanitizer is not load-bearing here, so the bypass has
nothing to bypass. That escaping moved to `lib/html.ts` and is now tested, so
the mitigation cannot be deleted quietly.

The upgrade was still attempted, on the principle that a mitigated critical is
not a fixed one. maplibre 6 is ESM-only and drops its default export, which is
a small change; the blocker is larger. Under Next 15's bundler the GeoJSON
source never finishes loading - `isSourceLoaded` stays false, `querySourceFeatures`
returns nothing, and **no pins render at all**. The map is the product's main
surface, and shipping it blank to close a hole that is already closed by our
own escaping would be a bad trade. Tracked in TODO.md with the symptom named,
so the next attempt starts from the evidence rather than from scratch.

sharp was upgraded (0.33.5 → 0.35.4) without hesitation and is a different
case entirely: those are libvips and libheif CVEs in a decoder that runs on
**untrusted uploads**, which is the worst possible place to carry one. AVIF is
in the accepted format list, so the libheif issues were directly reachable.

## Cluster counts should not depend on the basemap

Found while investigating the above, and true on either version: the cluster
count labels were rendered only on maplibre's `idle` event, guarded by
`isStyleLoaded()`.

Both are about the basemap. `idle` means "every tile is loaded and nothing is
animating", so a slow, blocked or failing tile server means it never arrives -
and every cluster count silently vanishes from a map that is otherwise working.
The pins are ours, drawn from our own GeoJSON source; whether OpenStreetMap is
having a bad day has nothing to do with whether we can count them.

The guard is now "does our source exist", and the labels also render on
`moveend` and on `sourcedata` for our own source. `renderClusterLabels` was
already idempotent - it reuses markers by cluster id and removes the ones that
no longer exist - so firing it more often costs one `querySourceFeatures`.
