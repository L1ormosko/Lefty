// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn, type SortState } from "./DataTable";

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (row) => row.name, sortable: true },
  { key: "id", header: "Identifier", cell: (row) => row.id },
];

const rows: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

function renderTable(overrides: { sort?: SortState | null; rows?: Row[]; page?: number } = {}) {
  const onSortChange = vi.fn();
  const onPageChange = vi.fn();
  render(
    <DataTable
      caption="People"
      columns={columns}
      rows={overrides.rows ?? rows}
      getRowId={(row) => row.id}
      sort={overrides.sort ?? null}
      onSortChange={onSortChange}
      pagination={{
        page: overrides.page ?? 2,
        pageSize: 2,
        totalItems: 6,
        onPageChange,
        labels: { navigation: "Pages", previous: "Previous", next: "Next", status: "Page 2 of 3" },
      }}
      emptyState={<p>Nothing here</p>}
    />,
  );
  return { onSortChange, onPageChange };
}

describe("DataTable", () => {
  it("renders headers and rows from props", () => {
    renderTable();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "People" })).getByText("Beta")).toBeInTheDocument();
  });

  it("emits page changes for next and previous", async () => {
    const { onPageChange } = renderTable({ page: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 3);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 1);
  });

  it("disables Previous on the first page", () => {
    renderTable({ page: 1 });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("emits ascending sort when an unsorted column header is activated", async () => {
    const { onSortChange } = renderTable();
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ columnKey: "name", direction: "asc" });
  });

  it("toggles an ascending column to descending", async () => {
    const { onSortChange } = renderTable({ sort: { columnKey: "name", direction: "asc" } });
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ columnKey: "name", direction: "desc" });
  });

  it("does not render a sort button for non-sortable columns", () => {
    renderTable();
    expect(screen.queryByRole("button", { name: "Identifier" })).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no rows", () => {
    renderTable({ rows: [] });
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});
