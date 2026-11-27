// Enterprise analytics (spec Part 13, 2): the KPI engine over the one catalog in `src/lib/kpi-catalog.ts`. Read-only: it reads
// through the reporting read client and writes no business table (denials are audited by the authz module).
export { computeKpi, isKpiComputed } from "./engine";
export type { KpiResult, KpiDrillDown } from "./engine";
export { listVisibleKpis } from "./catalog-view";
export type { KpiCatalogEntryView } from "./catalog-view";
export { resolveKpiAccess } from "./access";
export type { KpiAccess } from "./access";
export { withReportingTenant } from "./read-client";
export { kpiQuerySchema, kpiKeyParams } from "./schemas";
export type { KpiQuery } from "./schemas";
export { MAX_SOURCE_ROWS } from "./compute-context";
