# VELTO — Costs

Three separate questions, answered separately: what it costs to run, what this
build session cost, and what VELTO should eventually charge its users.

## 1. Monthly infrastructure — MVP / pilot scale

Assumes a Be'er Sheva pilot: dozens of assets, low hundreds of registered
users, no meaningful traffic spike. Ranges show a free-tier floor and a
realistic paid floor once free tiers are outgrown.

| Component | Why it's needed | Free-tier floor | Realistic paid floor |
| --- | --- | --- | --- |
| PostgreSQL (managed) | primary datastore | $0 (Neon/Supabase free tier) | ~$15–25/mo (small dedicated instance) |
| App host (Node runtime) | `sharp` image processing needs a real Node process, not a pure edge/serverless function | $0–7/mo (Render free/starter, Railway hobby) | ~$15–25/mo (always-on small instance) |
| Object storage for images | not yet — images live in Postgres, which holds ~250 fully photographed assets per GB. Needed once inventory outgrows that (see DECISIONS.md §14) | $0 today | $0 (10GB free on Cloudflare R2, no egress fee) to a few $/mo |
| Map tiles (commercial provider) | production traffic — the default keyless OSM style is dev-only | $0 (MapTiler/Mapbox free tiers cover tens of thousands of loads/mo) | $0–50/mo depending on traffic |
| Domain | `velto.co.il` or similar | — | ~$10–15/year |
| Transactional email | once `notify()` gets an email backend | $0 (Resend/Postmark free tiers cover low thousands/mo) | ~$0–20/mo |

**Realistic total at pilot scale: roughly $0–100/month**, likely near the low
end for the first few months on free tiers, settling around $50–100/month
once the app needs an always-on paid host and a paid Postgres instance.

Not included because nothing in the MVP requires them yet: a CDN, a queue,
a cache layer, a second environment beyond dev/prod. Add them when there is
a measured reason to, per the project's anti-overengineering rule.

## 2. This build session — approximate Claude usage

This is an order-of-magnitude estimate, not an exact figure — the session
does not have access to precise token accounting for itself. Given as a
range with the reasoning shown, so it's a defensible estimate rather than an
invented number.

**Cost drivers in this session:**
- A full-stack MVP built from zero: schema, auth, ~25 routes, server actions,
  a MapLibre integration, an upload pipeline, a 7-step wizard, three role
  dashboards.
- Two rounds of subagent review (product/UX and engineering/security), each
  a substantial independent pass over the design and the code.
- Iterative screenshot-driven debugging of the map (several rounds of
  "render → screenshot → diagnose → fix" for layout/WebGL/tile issues).
- A full test suite (54 unit/integration tests, 14 Playwright journeys)
  written and debugged to green.

A build of this shape and size — roughly a day of a senior engineer's
output compressed into one session, with the back-and-forth of screenshot
debugging and two independent reviews — typically lands in the **low tens of
dollars** of API usage on current Claude pricing (a large context window
reused heavily across many tool calls, plus two subagent runs each doing
their own independent reading and reasoning). Treat this as a ballpark for
budgeting, not an invoice-grade number.

## 3. Recommended future pricing model for end users

Per `DECISIONS.md` §59, the schema deliberately does not assume any one
model — no payment fields exist on `Booking` yet. Recommendation for the
sequence:

**Phase 1 (now → early traction): a listing or lead fee, billed manually.**
Charge media owners either a small flat monthly fee per active listing, or a
fee per qualified inquiry/booking request they receive. This requires **zero**
new payment infrastructure — invoice manually or via a simple monthly
Stripe/Meshulam charge outside the app — and is honest at low volume: there
isn't enough transaction flow yet to justify commission plumbing.

**Phase 2 (once there's real booking volume): commission on completed
bookings.** This is the model the product is actually built for
(`Booking.priceEstimate` already exists as the number a commission would be
computed against), but it needs a payment capture step that does not exist
in the MVP on purpose — building it now, before there is real transaction
volume to validate the commission rate against, would be speculative
infrastructure the project's anti-overengineering rule explicitly warns
against.

**Not recommended for the MVP stage:** an advertiser-side subscription
(nothing yet justifies paying for planning tools beyond the free discovery
flow) or a hybrid model (adds billing complexity before either side alone is
proven).
