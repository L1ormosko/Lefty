# LEADRO — Implementation Plan: Phase 6 (Enterprise Analytics) — backend

Spec: `leadro/docs/SPEC.md` (binding), especially Part 13 (§13.1–13.5), §2 ("heavy reporting ... can later be
separated from the main transactional workload"), §3 ("historical reports must use the appropriate historical
organizational assignment"), §4.5 matrix rows Reports / Financial reports, §22.2 (financial reports are
sensitive), §23.1–23.2 (pagination, indexes, multi-state reporting), §28.4 (compensation blocked).
Scope decision: UI deferred (owner) — dashboards are JSON read models behind `/api/v1/analytics/*`.

## Global Constraints (Phase 1–5 constraints still bind)

- One KPI catalog (§13.4): every KPI is a code-defined entry in `src/lib/kpi-catalog.ts` with key, formal
  definition, calculation formula, source records, time-period semantics, applicable scopes, responsible
  data owner (a role, configurable per tenant later), unit (count, rate, duration, money) and required
  permission / field set. Dashboards reference KPIs by key only — the same key never means two things
  (§13.4 last line); variants get their own key and label. `docs/KPI_DEFINITIONS.md` is generated from the
  catalog and a drift test keeps them equal.
- No invented numbers: compensation and commission expense KPIs exist in the catalog with status
  `BLOCKED_ON_SPEC` (§28.4) and always return that status, never a value. Estimates are labelled as such
  (recovered revenue: confirmed vs estimated, §9.7). Distances are straight-line estimates.
- Money: BigInt minor units per currency; never sum across currencies (results grouped by currency).
- Attribution: job/lead/payment KPIs attribute to the org unit snapshotted on the record (job.orgUnitId,
  exception.orgUnitId ...); employee KPIs attribute to the OrganizationalAssignment effective at the event
  time (§3), never to today's assignment. Documented per KPI.
- Scope and sensitivity: every query goes through `withinScope`; financial KPIs require finance permissions
  and the financial field set; performance data follows Phase 5 rules (no universal score; employee-level
  analytics only through the Phase 5 read models, never ranking lists of individuals by a combined score).
- Separability (§2): analytics reads go through one module (`src/server/analytics`) using a read client that
  can point at a replica (`REPORTING_DATABASE_URL`, falls back to the primary; RLS still applies via
  `withTenant` semantics); no analytics code writes business tables.
- Exports (§13.5): permission `reports.export` + the dataset's own export permission, column-level field-set
  gating, row cap per synchronous export (no worker yet — larger exports refused with a truthful message),
  CSV with formula-injection escaping, every export audited (who, dataset, filters, columns, row count).
- Same module/pipeline/RLS/audit/i18n/doc rules; new migrations only in Task 1.

## Task 1: Phase 6 schema + permission catalog
SavedReportView (owner, name, dataset key, columns, filters JSON, scope filter, shared with roles?,
archived), ReportExport (log row: actor, dataset, filters hash + JSON, columns, format, rowCount, status
COMPLETED | REFUSED_TOO_LARGE | FAILED, createdAt; append-only), indexes supporting the KPI aggregates
(review existing indexes on Job, Lead, Payment, LedgerEntry, JobOutcome, RecoveryCase by
(tenantId, orgUnitId, occurred/created at)). Permission catalog: analytics.* (VIEW per dashboard family:
executive, operational, financial, lead), reports.* (VIEW, CREATE, EXPORT, MANAGE); templates per §4.5
(Owner full; Executive/COO executive + operational; Finance Director financial reports + exports;
State/Regional/City managers scoped operational + local revenue per their financial grants; Lead Ops lead
analytics; Dispatcher operational subset; Technician none). RLS + tests.

## Task 2: KPI catalog + engine — operational and lead KPIs (§13.2, §13.4)
Catalog entries + engine (`computeKpi(tx, actor, key, { period, scope, groupBy })` → values with sample
counts and source-record drill-down query). Operational: lead response time, time to assignment, time to
arrival, job duration, jobs per employee, completed jobs, revisit rate, cancellation rate, unassigned jobs,
dispatch efficiency (definition chosen and documented: e.g. share of jobs assigned from a recommendation
without override, plus median assignment latency — two keys, not one blended number). Lead: volume by source,
conversion rate by source, recovery outcomes (confirmed vs estimated). Group by period (day/week/month in
tenant time zone) and org level (state/region/city/branch). KPI_DEFINITIONS.md + drift test.

## Task 3: Financial + executive KPIs (§13.1, §13.3)
Sold (approved), charged, collected revenue, outstanding amounts, material costs, direct costs (materials;
other direct costs not modelled yet — documented), gross profit (charged − direct costs, per currency),
refunds, adjustments, chargebacks, reconciliation exceptions (open/resolved), compensation + commission
expense (BLOCKED_ON_SPEC), employee productivity (completed jobs per scheduled shift hour — documented,
development use only, never per-employee ranking in executive views). All ledger-derived where the ledger is
the source of truth.

## Task 4: Dashboards (§13.1–13.3, §5 workspace widgets)
Read models: executive (company + state/region comparisons), state/regional, city/branch, finance, lead,
operational. Each dashboard = list of KPI keys + groupings; response carries KPI metadata (label key,
definition link, unit, period, scope, BLOCKED status). Comparisons across org units only within the
viewer's scope. Caching of read-only aggregates optional (per-request memo only; document).
APIs `/api/v1/analytics/*`.

## Task 5: Report builder + exports (§13.5)
Dataset registry (jobs, leads, customers, payments, ledger entries, job outcomes, recovery cases, training
records, follow-up tasks ...): per dataset the columns (with field set + permission), filters, date field,
scope column, default sort, max export rows. Query endpoint (paginated), saved views CRUD (own; sharing
limited to roles that already have the dataset permissions), CSV export (sync, capped, audited, escaped),
export history. APIs `/api/v1/reports/*`.

## Task 6: Hardening + MILESTONE-6
Whole-phase review, fixes, performance check on realistic seeded volume (document query timings measured,
not invented — §23.1), docs, `docs/MILESTONE-6.md` with limitations (no worker for large exports, no replica
configured, UI deferred, compensation KPIs blocked) and the rulings for the improvement round.
