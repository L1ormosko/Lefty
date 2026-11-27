// Dataset registry (spec 13.5)
export { REPORT_DATASETS, REPORT_DATASET_KEYS, getDataset } from "./catalog";
export type { ReportColumn, ReportColumnType, ReportDataset, ReportFilterKind } from "./dataset-types";

// Running reports
export { listDatasets, runReportQuery } from "./query";
export type { DatasetColumnView, DatasetView, ReportPage } from "./query";

// Saved views and sharing
export { listViews, getView, createView, updateView, archiveView, shareView, unshareView } from "./views";
export type { SavedViewView } from "./views";

// Exports and the export log
export { exportReport, listExports, CSV_CONTENT_TYPE } from "./exports";
export type { ExportLogView, ExportResult } from "./exports";

export {
  runReportSchema,
  createViewSchema,
  updateViewSchema,
  shareViewSchema,
  viewIdParams,
  viewShareParams,
  listViewsQuerySchema,
  listExportsQuerySchema,
} from "./schemas";
export type { RunReportInput, CreateViewInput, UpdateViewInput, ListViewsQuery, ListExportsQuery } from "./schemas";
