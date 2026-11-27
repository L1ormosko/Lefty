# analytics

The KPI engine of enterprise analytics (spec Part 13, 13.2, 13.4; spec 2 "heavy reporting can later be separated"). Every KPI is an
entry of the ONE catalog `src/lib/kpi-catalog.ts` (definitions generated into `docs/KPI_DEFINITIONS.md`); pure aggregation lives in
`src/lib/kpi-aggregation.ts`. Routes: `GET /api/v1/analytics/kpis`, `GET /api/v1/analytics/kpis/{key}` (`docs/API_REFERENCE.md`
"Analytics KPIs"). Decisions: `docs/DECISIONS.md` "Phase 6 Task 2".

Public API (`index.ts`):
- `computeKpi(actor, key, query, ctx?)`: values of one KPI grouped by period (`DAY | WEEK | MONTH | TOTAL`, tenant time zone) and org
  level (`TENANT | STATE | REGION | CITY | BRANCH`, via the current org tree), with numerator / denominator, sample counts and up to 50
  source record ids per row plus a drill-down descriptor. BLOCKED_ON_SPEC KPIs return that status and no rows.
- `listVisibleKpis(actor)`: the catalog entries the viewer qualifies for, with `computed`.
- `resolveKpiAccess(tx, actor, kpi, now)`: the viewer's org-unit coverage for one KPI (for Task 4 dashboards).
- `withReportingTenant(tenantId, fn)`: the read-only, tenant-bound read client.
- `isKpiComputed(key)`, `kpiQuerySchema`, `kpiKeyParams`, `MAX_SOURCE_ROWS`.

How a value is computed: (1) access is resolved on the PRIMARY (`withTenant`), so revocations apply at once: the union of the scopes
of the grants of any of the KPI's permissions that reveal its field set, with the KPI's sets (`dispatch_kpis`) passed as satisfied
sets; TENANT and ORG_UNIT scopes only. No coverage: 403, audited. (2) The fact loader of the key (`operational-facts.ts`,
`lead-facts.ts`) reads the source records through `withReportingTenant`, selecting them with `withinScope(scope, requested unit, own
filter)`. (3) `aggregateFacts` groups and reduces them.

Invariants:
1. Read-only: data reads run in a `READ ONLY` transaction (replica when `REPORTING_DATABASE_URL` is set, else the primary), with
   `app.tenant_id` bound like `withTenant`, so RLS applies. Nothing here writes a business table (`tests/analytics/architecture.test.ts`).
2. Attribution: job / lead / case KPIs use the org unit snapshotted on the record; `jobs_per_employee` uses the lead technician's
   PRIMARY placement effective at completion (spec 3), and drops jobs whose job or attributed unit is outside the viewer's scope.
3. Money is summed per currency only; recovery CONFIRMED revenue and ESTIMATED value are separate keys (`estimate: true`, spec 9.7).
4. No ranking of individuals: employee identities are only ratio contributors and never leave the engine (spec 10.3).
5. Bounded: ranges up to 366 days, at most 50,000 source records per request (else a truthful 400), drill-down ids capped at 50.
