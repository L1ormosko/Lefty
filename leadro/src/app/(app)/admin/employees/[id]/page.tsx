import Link from "next/link";
import { DatePicker, Select, StatusBadge, TextInput } from "@/components/ui";
import { can } from "@/server/authz";
import { getEmployee, listEmployeeAssignments } from "@/server/employees";
import { requireFullSession } from "../../../../_lib/page-context";
import { ActionDialog } from "../../_components/ActionDialog";
import { AdminField } from "../../_components/AdminField";
import { AccessDenied, AdminPage, Panel } from "../../_components/AdminPage";
import { AdminTable } from "../../_components/AdminTable";
import { ConfirmActionButton } from "../../_components/ConfirmActionButton";
import { CursorPager } from "../../_components/CursorPager";
import { InviteDialog } from "../../_components/InviteDialog";
import { fullNameOf, showDate, showDateTime, toneOfStatus, type SearchParams } from "../../_lib/format";
import { loadActiveUnits, loadLegalEntityOptions, loadRoleOptions, unitOptions, forbiddenAsNull } from "../../_lib/options";
import { loadForPage, queryParam } from "../../_lib/page-guard";
import { assignEmployeeAction } from "../../organization/actions";
import { endAssignmentAction, terminateEmployeeAction, updateEmployeeAction } from "../actions";

const ASSIGNMENT_KINDS = ["PRIMARY", "SECONDARY", "TEMPORARY"] as const;

/**
 * Employee profile. Fields arrive already projected by `getEmployee` (per the grant that matched
 * THIS employee), so the page shows what is present and marks the rest "Hidden"; it never decides
 * visibility itself. Edit is offered only when the caller sees every base field (the service also
 * refuses a write without the base field set).
 */
export default async function EmployeeProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const { id } = await params;
  const cursor = queryParam(await searchParams, "cursor");
  const viewer = { locale, timeZone };

  const loaded = await loadForPage(async () => ({
    employee: await getEmployee(actor, id),
    history: await forbiddenAsNull(listEmployeeAssignments(actor, id, { limit: 25, cursor })),
  }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const { employee, history } = loaded.data;

  const [units, legalEntities, roleOptions, mayEdit, mayAssign, mayTerminate, mayInvite] = await Promise.all([
    loadActiveUnits(actor, { active: "all" }),
    loadLegalEntityOptions(actor),
    loadRoleOptions(actor),
    can(actor, "employees.edit", { employeeId: id }),
    can(actor, "employees.assign", { employeeId: id }),
    can(actor, "employees.archive", { employeeId: id }),
    can(actor, "users.create", { employeeId: id }),
  ]);
  const unitName = (unitId: string | null) => (unitId ? (units.find((candidate) => candidate.id === unitId)?.name ?? t("ADMIN.HISTORY_UNKNOWN_UNIT")) : "—");
  const activeUnits = units.filter((unit) => unit.active);
  const hidden = t("ADMIN.HIDDEN_FIELD");
  const show = (value: unknown) => (value === undefined ? hidden : value === null || value === "" ? "—" : String(value));
  const status = employee.status === undefined ? undefined : String(employee.status);
  const isTerminated = status === "TERMINATED";
  // Every base field must be visible for the edit form to be honest (it pre-fills them).
  const seesAllBase = ["firstName", "lastName", "email", "phone", "jobTitle", "employeeNumber", "legalEntityId", "hireDate", "status"].every((key) => employee[key] !== undefined);
  const anyHidden = ["firstName", "lastName", "email", "phone", "jobTitle", "employeeNumber", "hireDate", "status", "terminationDate"].some((key) => employee[key] === undefined);
  const currentUnits = (employee.currentOrgUnitIds as string[] | undefined)?.map((unitId) => unitName(unitId));
  const hireDateValue = employee.hireDate ? new Date(employee.hireDate as Date | string).toISOString().slice(0, 10) : "";
  const dialogLabels = { cancelLabel: t("COMMON.CANCEL"), closeLabel: t("COMMON.CLOSE") };
  const name = fullNameOf(employee) || hidden;

  const fields: Array<[string, string]> = [
    [t("ADMIN.EMPLOYEE_NUMBER"), show(employee.employeeNumber)],
    [t("ADMIN.EMPLOYEE_JOB_TITLE"), show(employee.jobTitle)],
    [t("ADMIN.EMPLOYEE_EMAIL"), show(employee.email)],
    [t("ADMIN.EMPLOYEE_PHONE"), show(employee.phone)],
    [t("ADMIN.EMPLOYEE_HIRE_DATE"), employee.hireDate === undefined ? hidden : showDate(employee.hireDate, viewer)],
    [t("ADMIN.EMPLOYEE_LEGAL_EMPLOYER"), employee.legalEntityId === undefined ? hidden : employee.legalEntityId ? (legalEntities.find((entity) => entity.value === employee.legalEntityId)?.label ?? "—") : "—"],
    [t("ADMIN.EMPLOYEE_TEAM"), currentUnits === undefined ? hidden : currentUnits.length === 0 ? t("ADMIN.EMPLOYEE_UNPLACED") : currentUnits.join(", ")],
  ];
  if (employee.terminationDate) fields.push([t("ADMIN.EMPLOYEE_TERMINATION_DATE"), showDate(employee.terminationDate, viewer)]);

  const editAction =
    mayEdit.allowed && seesAllBase && !isTerminated ? (
      <ActionDialog triggerLabel={t("COMMON.EDIT")} triggerVariant="primary" title={t("ADMIN.EMPLOYEE_EDIT")} submitLabel={t("COMMON.SAVE")} action={updateEmployeeAction} {...dialogLabels}>
        <input type="hidden" name="employeeId" value={id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label={t("ADMIN.EMPLOYEE_FIRST_NAME")} htmlFor="edit-first" required>
            <TextInput id="edit-first" name="firstName" defaultValue={String(employee.firstName ?? "")} required maxLength={80} />
          </AdminField>
          <AdminField label={t("ADMIN.EMPLOYEE_LAST_NAME")} htmlFor="edit-last" required>
            <TextInput id="edit-last" name="lastName" defaultValue={String(employee.lastName ?? "")} required maxLength={80} />
          </AdminField>
        </div>
        <AdminField label={t("ADMIN.EMPLOYEE_EMAIL")} htmlFor="edit-email">
          <TextInput id="edit-email" name="email" type="email" dir="ltr" defaultValue={String(employee.email ?? "")} maxLength={254} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_PHONE")} htmlFor="edit-phone">
          <TextInput id="edit-phone" name="phone" type="tel" dir="ltr" defaultValue={String(employee.phone ?? "")} maxLength={32} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_JOB_TITLE")} htmlFor="edit-title">
          <TextInput id="edit-title" name="jobTitle" defaultValue={String(employee.jobTitle ?? "")} maxLength={120} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_NUMBER")} htmlFor="edit-number">
          <TextInput id="edit-number" name="employeeNumber" dir="ltr" defaultValue={String(employee.employeeNumber ?? "")} maxLength={40} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_HIRE_DATE")} htmlFor="edit-hire">
          <DatePicker id="edit-hire" name="hireDate" defaultValue={hireDateValue} />
        </AdminField>
        <AdminField label={t("ADMIN.EMPLOYEE_LEGAL_EMPLOYER")} htmlFor="edit-entity">
          <Select id="edit-entity" name="legalEntityId" defaultValue={String(employee.legalEntityId ?? "")} options={legalEntities} placeholder={t("ADMIN.NONE")} />
        </AdminField>
        <AdminField label={t("ADMIN.STATUS")} htmlFor="edit-status">
          <Select id="edit-status" name="status" defaultValue={status === "ON_LEAVE" ? "ON_LEAVE" : "ACTIVE"} options={(["ACTIVE", "ON_LEAVE"] as const).map((value) => ({ value, label: t(`ADMIN.EMPLOYEE_STATUS_${value}`) }))} />
        </AdminField>
      </ActionDialog>
    ) : undefined;

  return (
    <AdminPage
      title={name}
      intro={employee.jobTitle ? String(employee.jobTitle) : undefined}
      primaryAction={editAction}
    >
      <p className="text-sm">
        <Link className="text-brand-700 underline" href="/admin/employees">
          {t("ADMIN.EMPLOYEE_BACK")}
        </Link>
      </p>
      <Panel title={t("ADMIN.EMPLOYEE_DETAILS")} action={status ? <StatusBadge tone={toneOfStatus(status)} label={t(`ADMIN.EMPLOYEE_STATUS_${status}`)} /> : undefined}>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt className="text-ink-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {anyHidden ? <p className="mt-4 text-xs text-ink-muted">{t("ADMIN.EMPLOYEE_FIELDS_HIDDEN_NOTE")}</p> : null}
      </Panel>

      <Panel
        title={t("ADMIN.EMPLOYEE_PLACEMENTS")}
        action={
          mayAssign.allowed && !isTerminated ? (
            <ActionDialog triggerLabel={t("ADMIN.ORG_ASSIGN_EMPLOYEE")} title={t("ADMIN.ORG_ASSIGN_EMPLOYEE")} description={t("ADMIN.ORG_ASSIGN_HELP")} submitLabel={t("COMMON.ASSIGN")} action={assignEmployeeAction} {...dialogLabels}>
              <input type="hidden" name="employeeId" value={id} />
              <AdminField label={t("ADMIN.HISTORY_UNIT")} htmlFor="place-unit" required>
                <Select id="place-unit" name="orgUnitId" options={unitOptions(activeUnits, t)} placeholder={t("ADMIN.CHOOSE")} required />
              </AdminField>
              <AdminField label={t("ADMIN.ORG_ASSIGNMENT_KIND")} htmlFor="place-kind">
                <Select id="place-kind" name="kind" defaultValue="PRIMARY" options={ASSIGNMENT_KINDS.map((kind) => ({ value: kind, label: t(`ADMIN.ASSIGNMENT_KIND_${kind}`) }))} />
              </AdminField>
              <AdminField label={t("ADMIN.ORG_ASSIGNMENT_ENDS")} htmlFor="place-ends" hint={t("ADMIN.ORG_ASSIGNMENT_ENDS_HINT")}>
                <DatePicker id="place-ends" name="effectiveTo" />
              </AdminField>
              <AdminField label={t("ADMIN.REASON")} htmlFor="place-reason">
                <TextInput id="place-reason" name="reason" maxLength={500} />
              </AdminField>
            </ActionDialog>
          ) : undefined
        }
      >
        <AdminTable
          caption={t("ADMIN.EMPLOYEE_PLACEMENTS")}
          rows={history?.data ?? []}
          getRowId={(row) => row.id}
          emptyTitle={t("ADMIN.EMPLOYEE_PLACEMENTS_EMPTY_TITLE")}
          emptyDescription={t("ADMIN.EMPLOYEE_PLACEMENTS_EMPTY_DESCRIPTION")}
          columns={[
            { key: "unit", header: t("ADMIN.HISTORY_NEW"), cell: (row) => `${unitName(row.orgUnitId)} (${t(`ADMIN.ASSIGNMENT_KIND_SHORT_${row.kind}`)})` },
            { key: "previous", header: t("ADMIN.HISTORY_PREVIOUS"), cell: (row) => (row.kind === "PRIMARY" ? (row.previousOrgUnitId ? unitName(row.previousOrgUnitId) : t("ADMIN.HISTORY_NO_PREVIOUS")) : "—") },
            { key: "from", header: t("ADMIN.EFFECTIVE_FROM"), cell: (row) => showDateTime(row.effectiveFrom, viewer) },
            { key: "to", header: t("ADMIN.EFFECTIVE_TO"), cell: (row) => (row.effectiveTo ? showDateTime(row.effectiveTo, viewer) : t("ADMIN.ORG_CURRENT")) },
            { key: "reason", header: t("ADMIN.REASON"), cell: (row) => row.reason ?? "—" },
            {
              key: "actions",
              header: t("ADMIN.ACTIONS"),
              srOnlyHeader: true,
              cell: (row) =>
                mayAssign.allowed && row.kind !== "PRIMARY" && !row.effectiveTo ? (
                  <ConfirmActionButton
                    triggerLabel={t("ADMIN.ORG_END_MANAGER")}
                    title={t("ADMIN.EMPLOYEE_END_ASSIGNMENT")}
                    description={t("ADMIN.EMPLOYEE_END_ASSIGNMENT_HELP")}
                    confirmLabel={t("ADMIN.ORG_END_MANAGER")}
                    cancelLabel={t("COMMON.CANCEL")}
                    destructive
                    action={endAssignmentAction}
                    fields={{ employeeId: id, assignmentId: row.id }}
                  />
                ) : null,
            },
          ]}
        />
        <div className="mt-3">
          <CursorPager t={t} path={`/admin/employees/${id}`} params={{}} cursor={cursor} nextCursor={history?.page.nextCursor ?? null} />
        </div>
      </Panel>

      <Panel title={t("ADMIN.EMPLOYEE_ACCOUNT")}>
        <p className="mb-3 text-sm">{employee.userId === undefined ? hidden : employee.userId ? t("ADMIN.EMPLOYEE_HAS_LOGIN") : t("ADMIN.EMPLOYEE_NO_LOGIN")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {employee.userId ? (
            <a className="text-brand-700 underline" href="/admin/users">
              {t("ADMIN.EMPLOYEE_VIEW_USERS")}
            </a>
          ) : mayInvite.allowed && !isTerminated ? (
            <InviteDialog
              t={t}
              employeeId={id}
              defaultEmail={employee.email ? String(employee.email) : undefined}
              roleOptions={roleOptions}
              unitOptions={unitOptions(activeUnits, t)}
              legalEntityOptions={legalEntities}
            />
          ) : null}
        </div>
      </Panel>

      {mayTerminate.allowed && !isTerminated ? (
        <Panel title={t("ADMIN.EMPLOYEE_END_EMPLOYMENT")}>
          <p className="mb-3 text-sm text-ink-muted">{t("ADMIN.EMPLOYEE_TERMINATE_HELP")}</p>
          <ActionDialog
            triggerLabel={t("ADMIN.EMPLOYEE_TERMINATE")}
            triggerVariant="danger"
            title={t("ADMIN.EMPLOYEE_TERMINATE_TITLE", { name })}
            description={t("ADMIN.EMPLOYEE_TERMINATE_HELP")}
            submitLabel={t("ADMIN.EMPLOYEE_TERMINATE")}
            destructive
            action={terminateEmployeeAction}
            {...dialogLabels}
          >
            <input type="hidden" name="employeeId" value={id} />
            <AdminField label={t("ADMIN.EMPLOYEE_TERMINATION_DATE")} htmlFor="term-date" required>
              <DatePicker id="term-date" name="terminationDate" required />
            </AdminField>
            <AdminField label={t("ADMIN.REASON")} htmlFor="term-reason" required>
              <TextInput id="term-reason" name="reason" required maxLength={500} />
            </AdminField>
          </ActionDialog>
        </Panel>
      ) : null}
    </AdminPage>
  );
}
