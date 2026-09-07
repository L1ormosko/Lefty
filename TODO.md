# TODO

## Before showing it to a real customer
- [ ] Set `NEXT_PUBLIC_MAP_STYLE_URL` to a commercial tile provider (keyless OSM
      tiles are development-only under OSM's usage policy)
- [ ] Real inventory for Be'er Sheva, entered and verified through the admin
      queue — the map must never imply inventory we do not have
- [ ] Deploy: Node host + managed Postgres + object storage for uploads
- [ ] Email delivery behind `notify()` (owner gets an inquiry while offline)

## Done
- [x] Phase 0 reconnaissance, Phase 1 product and engineering review
- [x] Phase 2 foundation: schema, constraints, auth, roles, seed
- [x] Phase 3 map and discovery
- [x] Phase 4 media owner: wizard, images, availability, inquiries, bookings
- [x] Phase 5 advertiser: dashboard, saved assets, requests, bookings
- [x] Phase 6 admin: verification, users, requests, bookings
- [x] Phase 7 QA: 54 unit/integration tests, 14 E2E journeys, visual pass

## Deliberately out of MVP scope
- [ ] Payments, commission capture
- [ ] Digital slot-level marketplace (loops, plays, slot pricing)
- [ ] Campaign entity spanning several assets
- [ ] English UI translation (dictionary is wired, strings are not translated)
- [ ] Audience / traffic data — we have no trustworthy source, so we show none
