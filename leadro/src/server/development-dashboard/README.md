# development-dashboard

The manager development dashboard of one employee (spec 10.4 "Manager Development Dashboard"): strengths, development
opportunities, training recommendations, historical improvement, evidence behind metrics, coaching notes and review history.
Route: `GET /api/v1/employees/{id}/development` (`docs/API_REFERENCE.md` "Development dashboard"). Decisions:
`docs/DECISIONS.md` "Phase 5 Task 6".

Public API (`index.ts`): `getEmployeeDevelopment(actor, employeeId)`.

How it is built: a READ MODEL composed only from the public read functions of other modules (no own queries):
- `performance.listEmployeeCurrentValues(..., { publishedOnly: true })` enforces `performance.view` over the employee (403 / 404)
  and gives the current value per definition version, period and breakdown; values of never-published versions (previews)
  are left out;
- `performance.listPeerCurrentValues` gives the comparable colleagues' current values (same version, period and breakdown) in
  the VIEWER's `performance.view` scope, from which `src/lib/metric-position.ts` computes the position (quartile with the peer
  count, better / same / worse counts; no position below 4 comparable people or without enough data);
- `coaching.listCoachingRecords` / `listContextNotes`, `development.listPlans` / `getPlan` (review history) only when the viewer
  holds the `coaching` field set over the employee (`canViewFields(..., "performance.coaching_fields")`, Task 1 contract) and
  the owning module's view permission; otherwise the section is `null`;
- `development.listRecommendations` (OPEN) when the viewer holds `training.view` over the employee, else `null`.

Invariants:
1. Never a universal score: every number is one definition (one dimension), one period, one breakdown, with its sample size;
   the position is within that group only.
2. Writes nothing. Nothing in dispatch, qualifications, jobs, ledger, payments, approvals, employees or finance-adjustments
   imports it, and it imports only read functions (`tests/development-dashboard/architecture.test.ts`, spec 10.3).
3. Sections are bounded (50 notes, 10 plans, 50 recommendations); the owning modules' list endpoints page through the rest.
