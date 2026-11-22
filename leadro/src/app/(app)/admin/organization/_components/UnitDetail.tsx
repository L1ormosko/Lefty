import { Checkbox, Select, StatusBadge, TextInput, DatePicker } from "@/components/ui";
import { explainParentViolation, type OrgUnitTypeName } from "@/lib/org-hierarchy";
import type { TranslateFn } from "@/lib/i18n";
import { can } from "@/server/authz";
import type { Actor } from "@/server/core";
import { listEmployees } from "@/server/employees";
import { getOrgUnit, listUnitManagers } from "@/server/organization";
import { forbiddenAsNull } from "../../_lib/options";
import { ActionDialog } from "../../_components/ActionDialog";
import { AdminField } from "../../_components/AdminField";
import { Panel } from "../../_components/AdminPage";
import { AdminTable } from "../../_components/AdminTable";
import { ConfirmActionButton } from "../../_components/ConfirmActionButton";
import { CursorPager } from "../../_components/CursorPager";
import { fullNameOf, localeLabel, showDateTime, toneOfStatus, type ViewerFormat } from "../../_lib/format";
import { loadForPage } from "../../_lib/page-guard";
import { pathOf, subtreeIdsOf } from "../../_lib/unit-tree";
import type { UnitSummary } from "../../_lib/options";
import {
  archiveUnitAction,
  assignEmployeeAction,
  assignManagerAction,
  moveUnitAction,
  unassignManagerAction,
  updateUnitAction,
} from "../actions";

export interface UnitDetailProps {
  actor: Actor;
  t: TranslateFn;
  viewer: ViewerFormat;
  unitId: string;
  /** Every active unit the caller sees: breadcrumb, children and the move picker. */
  units: UnitSummary[];
  employeeOptions: Array<{ value: string; label: string }>;
  cursor: string | undefined;
  basePath: string;
  params: Record<string, string | undefined>;
}

const ASSIGNMENT_KINDS = ["PRIMARY", "SECONDARY", "TEMPORARY"] as const;

/** Detail panel of one unit: reporting line, managers (with history), people placed in it, and the actions. */
export async function UnitDetail({ actor, t, viewer, unitId, units, employeeOptions, cursor, basePath, params }: UnitDetailProps) {
  const loaded = await loadForPage(async () => ({
    unit: (await getOrgUnit(actor, unitId)) as unknown as UnitSummary,
    managers: await listUnitManagers(actor, unitId, { limit: 50, includeEnded: true }),
    people: await forbiddenAsNull(listEmployees(actor, { limit: 25, orgUnitId: unitId, cursor })),
  }));
  if (loaded.denied) return null;
  const { unit, managers, people } = loaded.data;

  const [mayEdit, mayArchive, mayAssign, mayPlace] = await Promise.all([
    can(actor, "organization.edit", { orgUnitId: unitId }),
    can(actor, "organization.archive", { orgUnitId: unitId }),
    can(actor, "organization.assign", { orgUnitId: unitId }),
    can(actor, "employees.assign"),
  ]);
  const labels = { cancelLabel: t("COMMON.CANCEL"), closeLabel: t("COMMON.CLOSE") };

  // The picker only offers parents the hierarchy rules allow and never the unit's own subtree;
  // the service still validates (and its answer is shown if something changed meanwhile).
  const forbidden = subtreeIdsOf(units, unitId);
  const parentChoices = units
    .filter((candidate) => !forbidden.has(candidate.id) && candidate.id !== unit.parentId)
    .filter((candidate) => explainParentViolation(unit.type as OrgUnitTypeName, candidate.type as OrgUnitTypeName) === null)
    .map((candidate) => ({ value: candidate.id, label: `${candidate.name} (${t(`ORG_UNIT_TYPE.${candidate.type}`)})` }));
  const canBeTopLevel = explainParentViolation(unit.type as OrgUnitTypeName, null) === null && unit.parentId !== null;
  const children = units.filter((candidate) => candidate.parentId === unitId);
  const breadcrumb = pathOf(units, unitId);

  return (
    <Panel
      title={unit.name}
      action={
        <>
          {mayEdit.allowed ? (
            <ActionDialog triggerLabel={t("ADMIN.ORG_RENAME")} title={t("ADMIN.ORG_RENAME")} submitLabel={t("COMMON.SAVE")} action={updateUnitAction} {...labels}>
              <input type="hidden" name="unitId" value={unitId} />
              <AdminField label={t("ADMIN.ORG_UNIT_NAME")} htmlFor="rename-name" required>
                <TextInput id="rename-name" name="name" defaultValue={unit.name} required maxLength={120} />
              </AdminField>
              <AdminField label={t("ADMIN.ORG_UNIT_CODE")} htmlFor="rename-code">
                <TextInput id="rename-code" name="code" defaultValue={unit.code ?? ""} maxLength={40} dir="ltr" />
              </AdminField>
            </ActionDialog>
          ) : null}
          {mayEdit.allowed && unit.active ? (
            <ActionDialog
              triggerLabel={t("ADMIN.ORG_MOVE")}
              title={t("ADMIN.ORG_MOVE")}
              description={t("ADMIN.ORG_MOVE_HELP")}
              submitLabel={t("ADMIN.ORG_MOVE")}
              action={moveUnitAction}
              {...labels}
            >
              <input type="hidden" name="unitId" value={unitId} />
              <AdminField label={t("ADMIN.ORG_NEW_PARENT")} htmlFor="move-parent">
                <Select
                  id="move-parent"
                  name="newParentId"
                  options={parentChoices}
                  placeholder={canBeTopLevel ? t("ADMIN.ORG_TOP_LEVEL") : t("ADMIN.ORG_CHOOSE_PARENT")}
                  defaultValue=""
                />
              </AdminField>
              <AdminField label={t("ADMIN.REASON")} htmlFor="move-reason">
                <TextInput id="move-reason" name="reason" maxLength={500} />
              </AdminField>
            </ActionDialog>
          ) : null}
          {mayArchive.allowed && unit.active ? (
            <ActionDialog
              triggerLabel={t("COMMON.ARCHIVE")}
              triggerVariant="danger"
              title={t("ADMIN.ORG_ARCHIVE_TITLE", { name: unit.name })}
              description={t("ADMIN.ORG_ARCHIVE_HELP")}
              submitLabel={t("COMMON.ARCHIVE")}
              destructive
              action={archiveUnitAction}
              {...labels}
            >
              <input type="hidden" name="unitId" value={unitId} />
              <AdminField label={t("ADMIN.REASON")} htmlFor="archive-reason">
                <TextInput id="archive-reason" name="reason" maxLength={500} />
              </AdminField>
            </ActionDialog>
          ) : null}
        </>
      }
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-muted">{t("ADMIN.ORG_UNIT_TYPE")}</dt>
          <dd className="font-medium">{t(`ORG_UNIT_TYPE.${unit.type}`)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">{t("ADMIN.STATUS")}</dt>
          <dd>
            <StatusBadge tone={unit.active ? "success" : "neutral"} label={unit.active ? t("ADMIN.STATUS_ACTIVE") : t("ADMIN.STATUS_ARCHIVED")} />
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-ink-muted">{t("ADMIN.ORG_REPORTS_TO")}</dt>
          <dd className="font-medium">{breadcrumb.length > 1 ? breadcrumb.slice(0, -1).join(" › ") : t("ADMIN.ORG_TOP_LEVEL")}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-ink-muted">{t("ADMIN.ORG_SUB_UNITS")}</dt>
          <dd className="font-medium">{children.length === 0 ? t("ADMIN.NONE") : children.map((child) => child.name).join(", ")}</dd>
        </div>
        {unit.defaultLocale ? (
          <div>
            <dt className="text-ink-muted">{t("COMMON.LANGUAGE")}</dt>
            <dd className="font-medium">{localeLabel(t, unit.defaultLocale)}</dd>
          </div>
        ) : null}
      </dl>

      <h3 className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2 text-base font-semibold">
        {t("ADMIN.ORG_MANAGERS")}
        {mayAssign.allowed && unit.active ? (
          <span className="flex items-center gap-2">
            <ActionDialog triggerLabel={t("ADMIN.ORG_ADD_MANAGER")} title={t("ADMIN.ORG_ADD_MANAGER")} submitLabel={t("COMMON.ASSIGN")} action={assignManagerAction} {...labels}>
              <input type="hidden" name="unitId" value={unitId} />
              <AdminField label={t("ADMIN.ORG_EMPLOYEE")} htmlFor="manager-employee" required>
                <Select id="manager-employee" name="employeeId" options={employeeOptions} placeholder={t("ADMIN.CHOOSE")} required />
              </AdminField>
              <Checkbox name="isPrimary" label={t("ADMIN.ORG_PRIMARY_MANAGER")} />
            </ActionDialog>
          </span>
        ) : null}
      </h3>
      <AdminTable
        caption={t("ADMIN.ORG_MANAGERS")}
        rows={managers.data}
        getRowId={(row) => row.id}
        emptyTitle={t("ADMIN.ORG_MANAGERS_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.ORG_MANAGERS_EMPTY_DESCRIPTION")}
        columns={[
          { key: "name", header: t("ADMIN.ORG_EMPLOYEE"), cell: (row) => fullNameOf(row.employee ?? {}) || t("ADMIN.HIDDEN_FIELD") },
          { key: "primary", header: t("ADMIN.ORG_PRIMARY_MANAGER"), cell: (row) => (row.isPrimary ? t("ADMIN.YES") : t("ADMIN.NO")) },
          { key: "from", header: t("ADMIN.EFFECTIVE_FROM"), cell: (row) => showDateTime(row.effectiveFrom, viewer) },
          { key: "to", header: t("ADMIN.EFFECTIVE_TO"), cell: (row) => (row.effectiveTo ? showDateTime(row.effectiveTo, viewer) : t("ADMIN.ORG_CURRENT")) },
          {
            key: "actions",
            header: t("ADMIN.ACTIONS"),
            srOnlyHeader: true,
            cell: (row) =>
              mayAssign.allowed && !row.effectiveTo ? (
                <ConfirmActionButton
                  triggerLabel={t("ADMIN.ORG_END_MANAGER")}
                  title={t("ADMIN.ORG_END_MANAGER")}
                  description={t("ADMIN.ORG_END_MANAGER_HELP")}
                  confirmLabel={t("ADMIN.ORG_END_MANAGER")}
                  cancelLabel={t("COMMON.CANCEL")}
                  destructive
                  action={unassignManagerAction}
                  fields={{ unitId, managerId: row.id }}
                />
              ) : null,
          },
        ]}
      />

      <h3 className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2 text-base font-semibold">
        {t("ADMIN.ORG_PEOPLE")}
        {mayPlace.allowed && unit.active ? (
          <span className="flex items-center gap-2">
            <ActionDialog triggerLabel={t("ADMIN.ORG_ASSIGN_EMPLOYEE")} title={t("ADMIN.ORG_ASSIGN_EMPLOYEE")} description={t("ADMIN.ORG_ASSIGN_HELP")} submitLabel={t("COMMON.ASSIGN")} action={assignEmployeeAction} {...labels}>
              <input type="hidden" name="orgUnitId" value={unitId} />
              <AdminField label={t("ADMIN.ORG_EMPLOYEE")} htmlFor="assign-employee" required>
                <Select id="assign-employee" name="employeeId" options={employeeOptions} placeholder={t("ADMIN.CHOOSE")} required />
              </AdminField>
              <AdminField label={t("ADMIN.ORG_ASSIGNMENT_KIND")} htmlFor="assign-kind">
                <Select id="assign-kind" name="kind" defaultValue="PRIMARY" options={ASSIGNMENT_KINDS.map((kind) => ({ value: kind, label: t(`ADMIN.ASSIGNMENT_KIND_${kind}`) }))} />
              </AdminField>
              <AdminField label={t("ADMIN.ORG_ASSIGNMENT_ENDS")} htmlFor="assign-ends" hint={t("ADMIN.ORG_ASSIGNMENT_ENDS_HINT")}>
                <DatePicker id="assign-ends" name="effectiveTo" />
              </AdminField>
              <AdminField label={t("ADMIN.REASON")} htmlFor="assign-reason">
                <TextInput id="assign-reason" name="reason" maxLength={500} />
              </AdminField>
            </ActionDialog>
          </span>
        ) : null}
      </h3>
      <AdminTable
        caption={t("ADMIN.ORG_PEOPLE")}
        rows={people?.data ?? []}
        getRowId={(row) => String(row.id)}
        emptyTitle={t("ADMIN.ORG_PEOPLE_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.ORG_PEOPLE_EMPTY_DESCRIPTION")}
        columns={[
          {
            key: "name",
            header: t("ADMIN.EMPLOYEE_NAME"),
            cell: (row) => <a className="text-brand-700 underline" href={`/admin/employees/${String(row.id)}`}>{fullNameOf(row) || String(row.id)}</a>,
          },
          { key: "title", header: t("ADMIN.EMPLOYEE_JOB_TITLE"), cell: (row) => String(row.jobTitle ?? "—") },
          { key: "status", header: t("ADMIN.STATUS"), cell: (row) => <StatusBadge tone={toneOfStatus(String(row.status))} label={t(`ADMIN.EMPLOYEE_STATUS_${String(row.status)}`)} /> },
        ]}
      />
      <div className="mt-3">
        <CursorPager t={t} path={basePath} params={params} cursor={cursor} nextCursor={people?.page.nextCursor ?? null} cursorParam="people" />
      </div>
      <p className="mt-4 text-sm">
        <a className="text-brand-700 underline" href={`/admin/organization/history?unit=${unitId}`}>
          {t("ADMIN.ORG_VIEW_HISTORY")}
        </a>
      </p>
    </Panel>
  );
}
