import { DatePicker, Select, StatusBadge, TextInput } from "@/components/ui";
import { can } from "@/server/authz";
import { listEmployees } from "@/server/employees";
import { requireFullSession } from "../../../_lib/page-context";
import { ActionDialog } from "../_components/ActionDialog";
import { AdminField } from "../_components/AdminField";
import { AccessDenied, AdminPage } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { CursorPager } from "../_components/CursorPager";
import { SearchForm } from "../_components/SearchForm";
import { fullNameOf, toneOfStatus, type SearchParams } from "../_lib/format";
import { loadActiveUnits, loadLegalEntityOptions, unitOptions } from "../_lib/options";
import { loadForPage, queryParam } from "../_lib/page-guard";
import { createEmployeeAction } from "./actions";

const PATH = "/admin/employees";
const STATUSES = ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const;
type Status = (typeof STATUSES)[number];

/**
 * Employee directory. Rows come back already scoped (only people in the caller's units) and
 * field-projected by the service; a field the caller may not see is shown as "Hidden", never blank,
 * so a restricted view cannot be mistaken for missing data.
 */
export default async function EmployeesPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t } = await requireFullSession();
  const query = await searchParams;
  const search = queryParam(query, "search");
  const unit = queryParam(query, "unit");
  const statusParam = queryParam(query, "status");
  const status = STATUSES.find((candidate) => candidate === statusParam) as Status | undefined;
  const cursor = queryParam(query, "cursor");

  const loaded = await loadForPage(() => listEmployees(actor, { limit: 25, cursor, search, status, orgUnitId: unit }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const [units, legalEntities, mayCreate] = await Promise.all([
    loadActiveUnits(actor),
    loadLegalEntityOptions(actor),
    can(actor, "employees.create"),
  ]);
  const unitName = new Map(units.map((candidate) => [candidate.id, candidate.name]));
  const hidden = t("ADMIN.HIDDEN_FIELD");
  const text = (value: unknown) => (value === undefined ? hidden : value === null || value === "" ? "—" : String(value));

  const addEmployee = mayCreate.allowed ? (
    <ActionDialog
      triggerLabel={t("ADMIN.EMPLOYEE_ADD")}
      triggerVariant="primary"
      title={t("ADMIN.EMPLOYEE_ADD")}
      submitLabel={t("COMMON.CREATE")}
      cancelLabel={t("COMMON.CANCEL")}
      closeLabel={t("COMMON.CLOSE")}
      action={createEmployeeAction}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminField label={t("ADMIN.EMPLOYEE_FIRST_NAME")} htmlFor="new-first" required>
          <TextInput id="new-first" name="firstName" required maxLength={80} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_LAST_NAME")} htmlFor="new-last" required>
          <TextInput id="new-last" name="lastName" required maxLength={80} />
        </AdminField>
      </div>
      <AdminField label={t("ADMIN.EMPLOYEE_EMAIL")} htmlFor="new-email">
        <TextInput id="new-email" name="email" type="email" dir="ltr" maxLength={254} />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_PHONE")} htmlFor="new-phone">
        <TextInput id="new-phone" name="phone" type="tel" dir="ltr" maxLength={32} />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_JOB_TITLE")} htmlFor="new-title">
        <TextInput id="new-title" name="jobTitle" maxLength={120} />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_NUMBER")} htmlFor="new-number">
        <TextInput id="new-number" name="employeeNumber" dir="ltr" maxLength={40} />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_HIRE_DATE")} htmlFor="new-hire">
        <DatePicker id="new-hire" name="hireDate" />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_LEGAL_EMPLOYER")} htmlFor="new-entity" hint={t("ADMIN.EMPLOYEE_LEGAL_EMPLOYER_HINT")}>
        <Select id="new-entity" name="legalEntityId" options={legalEntities} placeholder={t("ADMIN.NONE")} />
      </AdminField>
      <AdminField label={t("ADMIN.EMPLOYEE_TEAM")} htmlFor="new-unit" hint={t("ADMIN.EMPLOYEE_TEAM_HINT")}>
        <Select id="new-unit" name="orgUnitId" options={unitOptions(units, t)} placeholder={t("ADMIN.NONE")} />
      </AdminField>
    </ActionDialog>
  ) : undefined;

  return (
    <AdminPage title={t("ADMIN.EMPLOYEES_TITLE")} intro={t("ADMIN.EMPLOYEES_INTRO")} primaryAction={addEmployee}>
      <SearchForm t={t} search={search}>
        <div className="min-w-40">
          <label htmlFor="filter-status" className="sr-only">
            {t("ADMIN.STATUS")}
          </label>
          <Select id="filter-status" name="status" defaultValue={status ?? ""} placeholder={t("ADMIN.ALL_STATUSES")} options={STATUSES.map((value) => ({ value, label: t(`ADMIN.EMPLOYEE_STATUS_${value}`) }))} />
        </div>
        <div className="min-w-48">
          <label htmlFor="filter-unit" className="sr-only">
            {t("ADMIN.EMPLOYEES_FILTER_UNIT")}
          </label>
          <Select id="filter-unit" name="unit" defaultValue={unit ?? ""} placeholder={t("ADMIN.EMPLOYEES_ALL_UNITS")} options={unitOptions(units, t)} />
        </div>
      </SearchForm>
      <AdminTable
        caption={t("ADMIN.EMPLOYEES_TITLE")}
        rows={loaded.data.data}
        getRowId={(row) => String(row.id)}
        emptyTitle={t("ADMIN.EMPLOYEES_EMPTY_TITLE")}
        emptyDescription={t(search || status || unit ? "ADMIN.EMPLOYEES_EMPTY_FILTERED" : "ADMIN.EMPLOYEES_EMPTY_DESCRIPTION")}
        emptyAction={search || status || unit ? undefined : addEmployee}
        columns={[
          {
            key: "name",
            header: t("ADMIN.EMPLOYEE_NAME"),
            cell: (row) => (
              <a className="font-medium text-brand-700 underline" href={`${PATH}/${String(row.id)}`}>
                {row.firstName === undefined ? hidden : fullNameOf(row)}
              </a>
            ),
          },
          { key: "number", header: t("ADMIN.EMPLOYEE_NUMBER"), cell: (row) => <span dir="ltr">{text(row.employeeNumber)}</span> },
          { key: "title", header: t("ADMIN.EMPLOYEE_JOB_TITLE"), cell: (row) => text(row.jobTitle) },
          {
            key: "unit",
            header: t("ADMIN.EMPLOYEE_TEAM"),
            cell: (row) => {
              const ids = row.currentOrgUnitIds as string[] | undefined;
              if (ids === undefined) return hidden;
              return ids.length === 0 ? t("ADMIN.EMPLOYEE_UNPLACED") : ids.map((id) => unitName.get(id) ?? t("ADMIN.HISTORY_UNKNOWN_UNIT")).join(", ");
            },
          },
          {
            key: "status",
            header: t("ADMIN.STATUS"),
            cell: (row) =>
              row.status === undefined ? hidden : <StatusBadge tone={toneOfStatus(String(row.status))} label={t(`ADMIN.EMPLOYEE_STATUS_${String(row.status)}`)} />,
          },
        ]}
      />
      <CursorPager t={t} path={PATH} params={{ search, status, unit }} cursor={cursor} nextCursor={loaded.data.page.nextCursor} />
    </AdminPage>
  );
}
