# reports

The report builder (spec 13.5): a registry of datasets over other modules' tables, a paginated scoped query, saved views
with sharing by role, and synchronous, capped, audited CSV exports with their log. Reads business tables, writes only its
own (`SavedReportView`, `SavedReportViewShare`, `ReportExport`) and the audit log. API: `/api/v1/reports/*`
(docs/API_REFERENCE.md "Reports"); decisions: docs/DECISIONS.md "Phase 6 Task 5".

Public API (`index.ts`):
- `REPORT_DATASETS` / `getDataset`: jobs, job_outcomes, leads, customers, recovery_cases, follow_up_tasks,
  training_records, payments, ledger_entries. Each names its view + export permission, columns (type, field set,
  filter, sortable), date column, default sort, unit scope columns and export cap (`datasets-*.ts`).
- `listDatasets`, `runReportQuery` (`prepare.ts` builds the one scoped query), `listViews` / `getView` / `createView` /
  `updateView` / `archiveView` / `shareView` / `unshareView`, `exportReport`, `listExports`.

Invariants:
- Sensitivity is never re-decided here: a column's field set comes from its owner's field map (`fieldSetIn` throws at
  load for an unclassified column); owners without a map (payments, ledger, follow-ups, training) are `base` of their
  permission. Scope columns are the owners' ORG_UNIT / LEGAL_ENTITY columns; OWN / ASSIGNED and set-qualified grants
  never open a dataset (fail closed, only narrower).
- Columns no grant reveals are dropped and named (`hiddenColumns`); rows come only from grants that reveal every field
  set a filter or the date range reads; cells are projected per row; a sort the caller cannot read falls back to `id`.
- A saved or shared view is only a definition: the runner's own permissions, scope and field sets apply every time.
  Sharing needs `reports.manage` and a role that holds the dataset's view permission.
- An export needs `reports.export` + the dataset's export permission (rows inside both scopes), counts first, refuses
  over the cap (REFUSED_TOO_LARGE, nothing produced), and logs every attempt (`ReportExport` + `report.export` audit in
  one primary transaction; FAILED in its own one after a database error).
- Separability (spec 2): permissions, saved views and the scoped query are decided on the PRIMARY (`withTenant`, so a
  revoked grant applies at once); the rows of a query or export are then read through the analytics read client
  (`withReportingTenant` from `@/server/analytics`: a replica when `REPORTING_DATABASE_URL` is set, read-only, RLS bound). Text cells are formula-escaped
  (`src/lib/report-csv.ts`); money is a decimal string per row currency (never summed); instants are tenant-zone ISO.
- The export log is an audit read: `audit.view` (tenant-level) sees all, others their own.
