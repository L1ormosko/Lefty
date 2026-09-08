# TODO

## Deep audit backlog (5 parallel reviews: map, UX/state, data lifecycle,
## infrastructure, buy/sell loop). Ordered by what breaks first.

### P0 — will lose data or block launch
- [ ] **Uploaded photos are wiped on every deploy.** Render's filesystem is
      ephemeral, so `UPLOAD_DIR` is gone the moment the service restarts. Every
      photo an owner uploads disappears — and publishing now *requires* a photo,
      so listings silently break. Needs object storage (S3/R2/Cloudinary) before
      any real owner uploads anything.
- [ ] **No database backups.** Free-tier Postgres has none, and it expires
      2026-10-07. A paid plan with daily backups is the minimum before real data.
- [ ] **No way to delete a user's data**, although `/privacy` promises it.
      Either build the deletion path or correct the policy — the current state
      is a promise the product cannot keep.

### P1 — the flows have dead ends
- [x] ~~Filtering navigated the user off the map to the landing page~~ (fixed)
- [ ] A booking never reaches `COMPLETED`; approved bookings stay approved
      forever, so "what did I actually run last quarter" is unanswerable
- [ ] An owner cannot cancel an approved booking (only the advertiser can)
- [ ] An asset cannot be deleted, only deactivated
- [ ] The profile page is read-only: a typo'd phone number can never be fixed,
      and there is no password change for a logged-in user
- [ ] No thread on an inquiry — one question, one answer, no follow-up
- [ ] The admin asset queue defaults to "pending", which is empty, so an
      admin's first view is a blank page while 16 assets sit one tab away

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
- [ ] Every seeded asset has zero photos, so the whole marketplace reads as
      unfinished; the photo step of the wizard is effectively unexercised
- [ ] Notifications are undifferentiated duplicates with no link to the
      request or booking they refer to, and no per-item "mark read"
- [ ] Destructive actions (cancel booking, deactivate user) fire with no
      confirmation and no undo
- [ ] Submit buttons show no pending state, so a slow network invites a
      double submit
- [ ] A booking never shows which inquiry it came from
- [ ] The verification badge names no verifier and no date
- [ ] Price formatting differs on three screens; email and phone use two
      different LTR-isolation techniques on adjacent rows
- [ ] Mobile: the header row is cramped below 44px touch targets, and the
      asset page stacks ~2500px above the request form with no sticky CTA

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
