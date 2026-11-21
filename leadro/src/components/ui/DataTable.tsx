"use client";

import type { ReactNode } from "react";
import { cx, focusRing } from "./cx";
import { Pagination, type PaginationLabels } from "./Pagination";
import { SortAscIcon, SortDescIcon, SortIcon } from "./icons";

export type SortDirection = "asc" | "desc";

export interface SortState {
  columnKey: string;
  direction: SortDirection;
}

export interface DataTableColumn<Row> {
  key: string;
  /** Already-translated column header. */
  header: string;
  /** Renders the cell content for a row. */
  cell: (row: Row) => ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<Row> {
  /** Accessible table caption (visually hidden). */
  caption: string;
  columns: DataTableColumn<Row>[];
  /** Current page of rows, already filtered and sorted by the data source. */
  rows: Row[];
  getRowId: (row: Row) => string;
  sort: SortState | null;
  /** Emitted when a sortable header is activated; cycles asc -> desc -> asc. */
  onSortChange: (sort: SortState) => void;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    onPageChange: (page: number) => void;
    labels: PaginationLabels;
  };
  /** Slot above the table for a FilterPanel / Search (§24.3: tables support filtering). */
  toolbar?: ReactNode;
  /** Shown instead of the body when there are no rows (use EmptyState). */
  emptyState: ReactNode;
}

function ariaSortFor(sort: SortState | null, columnKey: string): "ascending" | "descending" | "none" {
  if (sort?.columnKey !== columnKey) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/**
 * Controlled data table. It owns no data state: rows, sort and page arrive via props and changes
 * are emitted through callbacks, so server-side pagination/sorting can be wired in later.
 * Wide tables scroll horizontally inside their container (responsive, §24.1).
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  pagination,
  toolbar,
  emptyState,
}: DataTableProps<Row>) {
  const pageCount = Math.max(1, Math.ceil(pagination.totalItems / pagination.pageSize));

  return (
    <div className="space-y-3">
      {toolbar}
      <div className="overflow-x-auto rounded border border-line bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-neutral-soft">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={column.sortable ? ariaSortFor(sort, column.key) : undefined}
                  className="px-3 py-2 text-start font-semibold text-ink"
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className={cx("inline-flex items-center gap-1 rounded", focusRing)}
                      onClick={() =>
                        onSortChange({
                          columnKey: column.key,
                          direction:
                            sort?.columnKey === column.key && sort.direction === "asc" ? "desc" : "asc",
                        })
                      }
                    >
                      {column.header}
                      {sort?.columnKey !== column.key ? (
                        <SortIcon className="text-ink-muted" />
                      ) : sort.direction === "asc" ? (
                        <SortAscIcon />
                      ) : (
                        <SortDescIcon />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {rows.length > 0 ? (
            <tbody>
              {rows.map((row) => (
                <tr key={getRowId(row)} className="border-t border-line">
                  {columns.map((column) => (
                    <td key={column.key} className="px-3 py-2 text-start align-top text-ink">
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
        {rows.length === 0 ? emptyState : null}
      </div>
      <Pagination
        page={pagination.page}
        pageCount={pageCount}
        onPageChange={pagination.onPageChange}
        labels={pagination.labels}
      />
    </div>
  );
}
