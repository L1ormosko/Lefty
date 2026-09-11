# TODO

## Deep audit backlog (5 parallel reviews: map, UX/state, data lifecycle,
## infrastructure, buy/sell loop). Ordered by what breaks first.

### P0 — will lose data or block launch
- [x] ~~Uploaded photos are wiped on every deploy~~ — image bytes now live in
      Postgres (`MediaAssetImageBlob`, served by `/api/images/[id]`). See
      DECISIONS.md §14. Run `npx tsx prisma/backfill-image-blobs.ts` once per
      environment, then remove `UPLOAD_DIR`.
- [ ] **Swap `src/server/storage.ts` for object storage before ~250 assets.**
      Postgres holds roughly 250 fully photographed assets per GB, and the free
      tier is 1GB. This is a known ceiling, not a surprise — but it arrives
      without warning, so watch the count.
- [ ] Images are served unauthenticated by id, matching the old static
      `/uploads/<uuid>.webp` behaviour. An image belonging to a non-ACTIVE
      asset should arguably be owner/admin-only, the way `getPublicAsset`
      already is.
- [ ] **No database backups.** Free-tier Postgres has none, and **it is deleted
      on 2026-10-07** — that is a hard date, not an estimate. A paid plan with
      daily backups is the minimum before real customer data.
      There is now a manual route out, because the usual one does not work here
      (the instance's IP allow-list is empty, so `pg_dump` cannot connect, and
      the service's disk is ephemeral): download `/api/admin/backup` as an
      ADMIN, then `npm run backup:check <file>` against the live database, and
      `npm run backup:restore <file>` into the new one. See README and
      DECISIONS.md §17. **Nobody is reminded of the date automatically — put it
      in a calendar.**
- [x] ~~No way to delete a user's data~~ — the three rights the policy promises
      (see, correct, erase) are live on the profile page for both roles. Erasure
      is anonymization: see DECISIONS.md §15 for why a hard delete would have
      destroyed the counterparty's records.

### P1 — the flows have dead ends
- [x] ~~Filtering navigated the user off the map to the landing page~~ (fixed)
- [x] ~~A booking never reaches `COMPLETED`~~ — derived from the end date in
      `lib/bookings.ts`, never stored (no scheduled job exists to flip rows)
- [x] ~~An owner cannot cancel an approved booking~~ — the server always
      supported it; only the button was missing
- [x] ~~An asset cannot be deleted~~ — a draft nobody engaged with is deleted;
      anything else deactivates, because MediaAsset cascades to other people's
      bookings (DECISIONS.md §15 is the same trap)
- [x] ~~The profile page is read-only~~ — profile editing, company details and
      password change now exist, and media owners have an account page at all
- [x] ~~No thread on an inquiry~~ — `InquiryMessage` plus detail pages for both
      sides, which did not exist at all before
- [x] ~~The admin asset queue opens on a blank page~~ — every tab shows its
      count and the empty state links to "all"

### P2 — correctness and scale
- [ ] Availability is computed in JS *after* `take`, so pagination would drop
      rows. Nothing paginates yet — that is the bug waiting to happen.
- [ ] No pagination anywhere (assets, requests, bookings, notifications,
      admin lists)
- [ ] The rate limiter is in-process; a second instance halves every limit
- [ ] No audit log of admin actions (verify, reject, deactivate a user)
- [ ] No error tracking, no `/healthz`, no uptime check

### P3 — map and UX polish (from the map + screen-by-screen reviews)
- [ ] Commercial basemap (the keyless OSM style is dev-only per OSM policy)
- [ ] Distinct marker icons per asset type instead of one coloured dot
- [ ] Address search / geocoding — today search only matches titles and cities
- [ ] Keep the viewport in the URL, and `fitBounds` to the results after a filter
- [ ] Hover on a result card highlights its marker (and back)
- [ ] Draggable mobile sheet (today it snaps between three fixed heights)
- [x] ~~Every seeded asset has zero photos~~ — schematic placeholders with
      "תמונת הדגמה" burned into the bitmap; never anything resembling a photo
- [x] ~~Notifications do not link to what they refer to~~ — message
      notifications open the thread itself
- [ ] Notifications still have no per-item "mark read", only "mark all"
- [x] ~~Destructive actions fire with no confirmation~~ — `ConfirmButton`,
      with distinct labels so the confirm and the back-out never read alike
- [x] ~~Submit buttons show no pending state~~ — verified; every real submit
      already had one, only logout and mark-all-read did not (both idempotent)
- [x] ~~A booking never shows which inquiry it came from~~ — `Booking.inquiryId`
      was stored and never rendered; now a link
- [x] ~~The verification badge names no date~~ — shows when it was verified
- [x] ~~Price formatting differs on three screens~~ — one `<Price>` component
- [x] ~~Mobile touch targets and the buried request form~~ — header controls
      are 44px on touch, and a sticky bar jumps to the form

## Before showing it to a real customer
- [ ] Set `NEXT_PUBLIC_MAP_STYLE_URL` to a commercial tile provider (keyless OSM
      tiles are development-only under OSM's usage policy)
- [ ] Real inventory for Be'er Sheva, entered and verified through the admin
      queue — the map must never imply inventory we do not have
- [ ] Deploy: Node host + managed Postgres + object storage for uploads
- [ ] Set `RESEND_API_KEY` / `EMAIL_FROM` (see `.env.example`) — the email
      code path exists and is wired into every notification and password
      reset, but nothing is actually sent until a real provider key is set
- [ ] Actually create the `support@velto.co.il` inbox referenced in the
      footer and the three legal documents — right now mail to it bounces
- [ ] Register `velto.co.il` (or whatever domain is chosen) — the legal pages
      and support address assume it exists

## Before real customers (business, not technical)
- [x] Terms of Service, Privacy Policy and platform rules — live at
      `/terms`, `/privacy`, `/takanon`; required checkbox at registration
- [ ] A registered business entity / VAT number to invoice media owners
      (the field exists on Company - `businessId` - but is optional and
      nothing enforces collecting it before an owner starts earning leads)
- [x] A support contact surfaced in the product (footer, on every page
      except the map shell itself)
- [ ] Ratify the pricing-model recommendation in `COSTS.md` §3 — this is a
      business decision, not a technical one; nothing in the code assumes
      one model over another
- [ ] Have the three legal documents reviewed by an actual lawyer before
      relying on them — they were drafted to be honest about what the
      product does today, not to be a substitute for legal counsel

## Done
- [x] Phase 0 reconnaissance, Phase 1 product and engineering review
- [x] Phase 2 foundation: schema, constraints, auth, roles, seed
- [x] Phase 3 map and discovery
- [x] Phase 4 media owner: wizard, images, availability, inquiries, bookings
- [x] Phase 5 advertiser: dashboard, saved assets, requests, bookings
- [x] Phase 6 admin: verification, users, requests, bookings
- [x] Phase 7 QA: unit/integration + E2E across desktop/mobile, visual pass
- [x] Marketing landing page split from the map (`/` vs `/explore`)
- [x] Business dashboards for admin and media owner (growth, funnel,
      geography, pipeline estimate)
- [x] Launch-readiness audit (buy-side and sell-side gaps) and fixes:
      - Company contact info now actually rendered on the public asset page
      - Approved bookings show the counterparty's contact info both ways
      - Publishing an asset now requires at least one photo
      - Password reset flow (request + token + reset), fully code-complete
      - Terms/Privacy consent required at registration, timestamped
      - Optional business ID (ח.פ./עוסק מורשה) captured for media owners
      - Site footer with legal links and support contact on every page
        except the fixed-viewport map shell

## Deliberately out of MVP scope
- [ ] Payments, commission capture
- [ ] Digital slot-level marketplace (loops, plays, slot pricing)
- [ ] Campaign entity spanning several assets
- [ ] English UI translation (dictionary is wired, strings are not translated)
- [ ] Audience / traffic data — we have no trustworthy source, so we show none
- [ ] Email verification on signup (password reset covers the more urgent
      "I'm locked out" case; verifying the email itself is a smaller risk)
- [ ] Booking confirmation as a downloadable/emailed receipt (today it's an
      in-app + emailed notification, not a formal document)
