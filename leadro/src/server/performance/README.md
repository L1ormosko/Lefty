# performance

The performance engine (spec 10.2): versioned metric definitions from a fixed kind catalog, publication through the approval engine,
computation per employee x period x job type / category with a minimum sample, and append-only values with evidence. Routes:
`/api/v1/performance/**` (`docs/API_REFERENCE.md` "Performance"). Pure formulas: `src/lib/performance-formulas.ts`. Decisions and the exact
formula of every kind: `docs/DECISIONS.md` "Phase 5 Task 3".

Public API (`index.ts`):
- Self-service (Task 6, `self-service` = no module permission, own rows): `listOwnCurrentValues`, `getOwnMetricValue` (published
  versions only, evidence on the detail). Dashboard read: `listPeerCurrentValues(actor, series)` = colleagues' current values per
  comparison group in the caller's `performance.view` scope (published only; ranks nothing). `listEmployeeCurrentValues` takes
  `{ publishedOnly }` for read models.
- Definitions: `createDefinition`, `createDefinitionVersion`, `updateDefinition` (DRAFT without values), `retireDefinition`, `listDefinitions`,
  `getDefinition`, `getMetricCatalog`.
- Publication: `submitDefinition` (approval request, subject `PERFORMANCE_METRIC_DEFINITION`), `withdrawDefinition`;
  `registerMetricDefinitionApprovalSubject` (module load + `src/server/notification-targets.ts`).
- Values: `computeMetricValues` (a person, `performance.manage`), `computeMetricValuesAsSystem` (future worker), `listMetricValues`,
  `getMetricValue` (with evidence ids), `listEmployeeCurrentValues`.

Invariants:
1. **Structural spec 10.3.** This module only READS jobs, arrivals, completions, outcomes, recovery cases, customer feedback and training
   assignments (inside the caller's transaction) and writes only its own two tables. Dispatch, qualifications, jobs, ledger, payments,
   approvals (core), employees and finance-adjustments never import it (`tests/performance/architecture.test.ts`).
2. **No universal score (10.4).** A value is one definition = one dimension, per employee, period and job type or category (none for
   TRAINING_PROGRESS), with numerator, denominator (opportunities), sample, `enoughData = sampleSize >= minSample` and evidence ids. No
   endpoint sums, averages or ranks across definitions or employees; params hold no weights or thresholds.
3. **Publication always needs approval.** Submit opens a request; the engine's "no policy" answer is refused (409
   `performance.publication_policy_missing`). On approval the PUBLISHED version of the key is retired first, then this one published; on
   rejection / cancellation / expiry it goes back to DRAFT. The author and the submitter never decide (separation of duties).
4. **Versions.** One kind per key; content editable only while DRAFT and before any value was computed from it; one open (DRAFT /
   PENDING_APPROVAL) version per key; one PUBLISHED per key (DB). Changes to a key's versions take a row lock on the key.
5. **Append-only values.** A recomputation inserts new rows; the newest `computedAt` per (definition, employee, period, breakdown) is current.
6. **Visibility.** `performance.view` over the employee (current placements / employer / OWN), filtered in SQL. Values of never-published
   versions are previews for `performance.configure` / `performance.manage` holders, never about themselves; definitions that were never
   published are visible to authors only.
