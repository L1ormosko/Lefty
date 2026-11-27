import { z, type ZodTypeAny } from "zod";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, ValidationError, zodIssuesToFieldIssues } from "@/server/core";
import type { ReportColumn, ReportDataset } from "./dataset-types";

/** Input schemas of `/api/v1/reports/*`. Shapes match the DB CHECKs of SavedReportView / ReportExport (Phase 6 Task 1). */

const id = z.string().trim().min(1).max(64);
const datasetKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "Expected a dataset key");
const columnKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/, "Expected a column key");
const columns = z
  .array(columnKey)
  .min(1)
  .max(200)
  .refine((list) => new Set(list).size === list.length, "Columns must not repeat");
/** Filters are validated against the dataset (`parseFilters`); at the boundary only the JSON shape is checked. */
const filters = z.record(z.string(), z.unknown());
const sort = z.object({ column: columnKey, direction: z.enum(["asc", "desc"]) }).strict();
const viewName = z.string().trim().min(1).max(120);

/** What a report is: dataset, columns, filters and the optional one org unit (with descendants) to narrow to. */
export const reportDefinitionSchema = z
  .object({ datasetKey, columns, filters: filters.default({}), scopeOrgUnitId: id.nullable().default(null) })
  .strict();
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

/**
 * A run: either a definition or a saved view (`viewId`), never both. `sort` overrides the dataset's default sort;
 * `cursor` / `limit` page the query (ignored by an export, which takes every row up to the cap).
 */
export const runReportSchema = z
  .object({
    viewId: id.optional(),
    datasetKey: datasetKey.optional(),
    columns: columns.optional(),
    filters: filters.optional(),
    scopeOrgUnitId: id.nullable().optional(),
    sort: sort.optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict()
  .superRefine((value, context) => {
    const hasDefinition = value.datasetKey !== undefined || value.columns !== undefined || value.filters !== undefined || value.scopeOrgUnitId !== undefined;
    if (value.viewId !== undefined && hasDefinition) {
      context.addIssue({ code: "custom", path: ["viewId"], message: "Send a saved view or a definition, not both" });
    } else if (value.viewId === undefined && (value.datasetKey === undefined || value.columns === undefined)) {
      context.addIssue({ code: "custom", path: [value.datasetKey === undefined ? "datasetKey" : "columns"], message: "Required" });
    }
  });
export type RunReportInput = z.infer<typeof runReportSchema>;

export const createViewSchema = reportDefinitionSchema.extend({ name: viewName }).strict();
export type CreateViewInput = z.infer<typeof createViewSchema>;

/** The dataset of a view never changes (another dataset is another view). */
export const updateViewSchema = z
  .object({ name: viewName.optional(), columns: columns.optional(), filters: filters.optional(), scopeOrgUnitId: id.nullable().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateViewInput = z.infer<typeof updateViewSchema>;

export const shareViewSchema = z.object({ roleId: id }).strict();
export const viewIdParams = z.object({ id });
export const viewShareParams = z.object({ id, roleId: id });

export const listViewsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    datasetKey: datasetKey.optional(),
    includeArchived: z.enum(["true", "false"]).default("false"),
  })
  .strict();
export type ListViewsQuery = z.infer<typeof listViewsQuerySchema>;

export const listExportsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    datasetKey: datasetKey.optional(),
    actorId: id.optional(),
    status: z.enum(["COMPLETED", "REFUSED_TOO_LARGE", "FAILED"]).optional(),
  })
  .strict();
export type ListExportsQuery = z.infer<typeof listExportsQuerySchema>;

/** Parsed filters of one dataset: an optional half-open date range on its date column plus per-column filters. */
export interface ReportFilters {
  dateFrom?: Date;
  dateTo?: Date;
  /** Column key -> allowed values (`in`) or the boolean to match. */
  columns: Record<string, string[] | boolean>;
}

const instant = z.string().datetime({ offset: true });

function filterSchemaOf(column: ReportColumn): ZodTypeAny | null {
  if (column.filter === "boolean") return z.boolean();
  if (column.filter !== "in") return null;
  const value =
    column.enumValues && column.enumValues.length > 0
      ? z.enum(column.enumValues as [string, ...string[]])
      : column.type === "currency"
        ? z.string().regex(/^[A-Z]{3}$/)
        : z.string().trim().min(1).max(64);
  return z.array(value).min(1).max(100);
}

const schemaCache = new Map<string, ZodTypeAny>();

function filtersSchemaFor(dataset: ReportDataset): ZodTypeAny {
  let schema = schemaCache.get(dataset.key);
  if (!schema) {
    const shape: Record<string, ZodTypeAny> = { dateFrom: instant.optional(), dateTo: instant.optional() };
    for (const column of dataset.columns) {
      const columnSchema = filterSchemaOf(column);
      if (columnSchema) shape[column.key] = columnSchema.optional();
    }
    schema = z
      .object(shape)
      .strict()
      .refine((value) => !value.dateFrom || !value.dateTo || Date.parse(value.dateFrom as string) < Date.parse(value.dateTo as string), {
        message: "dateFrom must be before dateTo",
        path: ["dateTo"],
      });
    schemaCache.set(dataset.key, schema);
  }
  return schema;
}

/**
 * Validates stored or requested filters against the dataset catalog (the DB only checks that they are an object).
 * @throws ValidationError naming `filters.<key>`
 */
export function parseFilters(dataset: ReportDataset, raw: Record<string, unknown>): ReportFilters {
  const parsed = filtersSchemaFor(dataset).safeParse(raw);
  if (!parsed.success) {
    const issues = zodIssuesToFieldIssues(parsed.error).map((issue) => ({ ...issue, field: `filters.${issue.field}` }));
    throw new ValidationError({ message: "The filters are not valid for this dataset.", field: issues[0]?.field, details: issues });
  }
  const { dateFrom, dateTo, ...byColumn } = parsed.data as Record<string, unknown>;
  return {
    ...(typeof dateFrom === "string" ? { dateFrom: new Date(dateFrom) } : {}),
    ...(typeof dateTo === "string" ? { dateTo: new Date(dateTo) } : {}),
    columns: byColumn as Record<string, string[] | boolean>,
  };
}
