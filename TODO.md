# TODO

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
