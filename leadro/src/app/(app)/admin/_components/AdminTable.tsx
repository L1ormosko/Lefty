import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui";

export interface AdminTableColumn<Row> {
  key: string;
  /** Already-translated header; leave empty (with `srOnlyHeader`) for an actions column. */
  header: string;
  cell: (row: Row) => ReactNode;
  srOnlyHeader?: boolean;
}

export interface AdminTableProps<Row> {
  caption: string;
  columns: AdminTableColumn<Row>[];
  rows: Row[];
  getRowId: (row: Row) => string;
  emptyTitle: string;
  emptyDescription: string;
  /** The primary action offered from the empty state, so a new tenant knows what to do first. */
  emptyAction?: ReactNode;
}

/**
 * Server-rendered table with the same look and semantics as the shared `DataTable`. `DataTable`
 * is a client component driven by page numbers and callbacks; the admin lists are server-paged by
 * cursor and render cells on the server, so a plain table keeps them simple and accessible.
 */
export function AdminTable<Row>({ caption, columns, rows, getRowId, emptyTitle, emptyDescription, emptyAction }: AdminTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-line bg-surface">
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-line bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-neutral-soft">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-2 text-start font-semibold">
                {column.srOnlyHeader ? <span className="sr-only">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowId(row)} className="border-t border-line align-top">
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 text-start">
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
