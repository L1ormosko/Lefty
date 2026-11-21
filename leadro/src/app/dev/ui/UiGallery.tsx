"use client";

import { useState } from "react";
import {
  AuditTimeline,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DatePicker,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FilterPanel,
  FormSection,
  Search,
  Select,
  Sidebar,
  StatusBadge,
  TextInput,
  TopNav,
  UserProfileCard,
  buttonClasses,
  type SortState,
  type StatusTone,
} from "@/components/ui";

interface DemoRow {
  id: string;
  name: string;
  status: StatusTone;
}

const ALL_ROWS: DemoRow[] = [
  { id: "1", name: "Dana Cohen", status: "success" },
  { id: "2", name: "Luis Ortega", status: "warning" },
  { id: "3", name: "Priya Nair", status: "danger" },
  { id: "4", name: "Sam Lee", status: "info" },
  { id: "5", name: "Alex Kim", status: "neutral" },
];
const PAGE_SIZE = 2;

/** Demo-only wiring of every ui component; `dir` is forwarded to portal overlays. */
export function UiGallery({ dir }: { dir: "ltr" | "rtl" }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sorted = [...ALL_ROWS].sort((a, b) => {
    if (!sort) return 0;
    const result = a.name.localeCompare(b.name);
    return sort.direction === "asc" ? result : -result;
  });
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.ceil(ALL_ROWS.length / PAGE_SIZE);

  return (
    <div className="space-y-8">
      <div className="flex h-72 overflow-hidden rounded border border-line">
        <Sidebar
          label="Main"
          header={<strong>LEADRO</strong>}
          items={[
            { id: "dash", label: "Dashboard", href: "#", isCurrent: true },
            { id: "leads", label: "Leads", href: "#" },
            { id: "jobs", label: "Jobs", href: "#" },
          ]}
          footer={<UserProfileCard name="Dana Cohen" subtitle="Manager" />}
        />
        <div className="flex-1">
          <TopNav
            start={<span className="font-semibold">Dashboard</span>}
            center={
              <Search
                value={query}
                onValueChange={setQuery}
                onSearch={() => {}}
                label="Search"
                placeholder="Search…"
                submitLabel="Search"
              />
            }
            end={<StatusBadge tone="success" label="Online" />}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["success", "warning", "danger", "info", "neutral"] as const).map((tone) => (
          <StatusBadge key={tone} tone={tone} label={tone} />
        ))}
      </div>

      <FilterPanel title="Filters" applyLabel="Apply" resetLabel="Reset" onApply={() => {}} onReset={() => {}}>
        <Field label="Status">
          {(props) => (
            <Select
              {...props}
              placeholder="Any"
              options={[
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ]}
            />
          )}
        </Field>
        <Field label="From date">{(props) => <DatePicker {...props} />}</Field>
      </FilterPanel>

      <DataTable
        caption="Demo people"
        columns={[
          { key: "name", header: "Name", sortable: true, cell: (row: DemoRow) => row.name },
          {
            key: "status",
            header: "Status",
            cell: (row: DemoRow) => <StatusBadge tone={row.status} label={row.status} />,
          },
        ]}
        rows={pageRows}
        getRowId={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          totalItems: ALL_ROWS.length,
          onPageChange: setPage,
          labels: { navigation: "Pagination", previous: "Previous", next: "Next", status: `Page ${page} of ${pageCount}` },
        }}
        emptyState={<EmptyState title="No people" description="Add someone to get started." />}
      />

      <FormSection title="Profile" description="Grouped form fields.">
        <Field label="Full name" hint="As on their ID" required>
          {(props) => <TextInput {...props} defaultValue="Dana Cohen" />}
        </Field>
        <Field label="Email" error="Enter an email like name@example.com" required>
          {(props) => <TextInput {...props} type="email" defaultValue="not-an-email" />}
        </Field>
        <Checkbox label="Send me notifications" description="You can change this later." />
      </FormSection>

      <AuditTimeline
        label="History"
        entries={[
          { id: "1", title: "Lead created", actor: "Dana Cohen", timestampLabel: "Nov 1, 09:00", timestampIso: "2026-11-01T09:00:00Z" },
          { id: "2", title: "Assigned to Luis", actor: "Dana Cohen", timestampLabel: "Nov 1, 09:05", timestampIso: "2026-11-01T09:05:00Z", description: "Region match." },
        ]}
      />

      <EmptyState
        title="Nothing here yet"
        description="Create your first item to see it listed."
        action={<button className={buttonClasses.primary}>Create item</button>}
      />

      <div className="flex gap-2">
        <button className={buttonClasses.secondary} onClick={() => setDialogOpen(true)}>
          Open dialog
        </button>
        <button className={buttonClasses.secondary} onClick={() => setDrawerOpen(true)}>
          Open drawer
        </button>
        <button className={buttonClasses.danger} onClick={() => setConfirmOpen(true)}>
          Delete…
        </button>
      </div>

      <Dialog
        open={dialogOpen}
        dir={dir}
        onClose={() => setDialogOpen(false)}
        title="Dialog title"
        description="Dialog description."
        closeLabel="Close"
        footer={<button className={buttonClasses.primary} onClick={() => setDialogOpen(false)}>Save</button>}
      >
        <Field label="Note">{(props) => <TextInput {...props} />}</Field>
      </Dialog>
      <Drawer open={drawerOpen} dir={dir} onClose={() => setDrawerOpen(false)} title="Drawer title" closeLabel="Close">
        <p className="text-sm">Drawer content.</p>
      </Drawer>
      <ConfirmDialog
        open={confirmOpen}
        dir={dir}
        destructive
        title="Delete this item?"
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
