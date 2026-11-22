import { Select, StatusBadge, TextInput } from "@/components/ui";
import { PERMISSION_CATALOG, permissionKey, can } from "@/server/authz";
import { getEffectiveAccess, listRoles } from "@/server/roles";
import { listUsers } from "@/server/users";
import { requireFullSession } from "../../../_lib/page-context";
import { ActionDialog } from "../_components/ActionDialog";
import { AdminField } from "../_components/AdminField";
import { AccessDenied, AdminPage, Panel } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { CursorPager } from "../_components/CursorPager";
import { SearchForm } from "../_components/SearchForm";
import { fullNameOf, showDateTime, type SearchParams } from "../_lib/format";
import { loadForPage, queryParam } from "../_lib/page-guard";
import { PermissionGrid } from "./_components/PermissionGrid";
import { cloneRoleAction, createRoleAction } from "./actions";

const PATH = "/admin/roles";

/**
 * Roles & Access: role list (create / clone), and the access diagnostic: pick a user, optionally a
 * permission and a record, and see their effective access and WHY a permission is or is not granted.
 */
export default async function RolesPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const query = await searchParams;
  const search = queryParam(query, "search");
  const cursor = queryParam(query, "cursor");
  const diagUser = queryParam(query, "user");
  const diagPermission = queryParam(query, "permission");
  const diagEmployee = queryParam(query, "employee");
  const diagUnit = queryParam(query, "unit");
  const viewer = { locale, timeZone };

  const loaded = await loadForPage(() => listRoles(actor, { limit: 25, cursor, search, active: "all" }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const [mayCreate, users] = await Promise.all([can(actor, "permissions.create"), listUsers(actor, { limit: 200 }).catch(() => null)]);
  const userOptions = (users?.data ?? []).map((user) => ({ value: String(user.id), label: `${fullNameOf(user) || "—"} (${String(user.email)})` }));
  const diagnostic = diagUser
    ? await loadForPage(() => getEffectiveAccess(actor, { userId: diagUser, permission: diagPermission, employeeId: diagEmployee, orgUnitId: diagUnit }))
    : null;

  const create = mayCreate.allowed ? (
    <ActionDialog triggerLabel={t("ADMIN.ROLES_CREATE")} triggerVariant="primary" title={t("ADMIN.ROLES_CREATE")} submitLabel={t("COMMON.CREATE")} cancelLabel={t("COMMON.CANCEL")} closeLabel={t("COMMON.CLOSE")} action={createRoleAction}>
      <AdminField label={t("ADMIN.ORG_UNIT_NAME")} htmlFor="role-name" required>
        <TextInput id="role-name" name="name" required maxLength={80} />
      </AdminField>
      <AdminField label={t("ADMIN.ROLES_DESCRIPTION")} htmlFor="role-desc">
        <TextInput id="role-desc" name="description" maxLength={500} />
      </AdminField>
      <PermissionGrid t={t} selected={new Set()} idPrefix="new-role" />
    </ActionDialog>
  ) : undefined;

  return (
    <AdminPage title={t("ADMIN.ROLES_TITLE")} intro={t("ADMIN.ROLES_INTRO")} primaryAction={create}>
      <SearchForm t={t} search={search} />
      <AdminTable
        caption={t("ADMIN.ROLES_TITLE")}
        rows={loaded.data.data}
        getRowId={(row) => String(row.id)}
        emptyTitle={t("ADMIN.ROLES_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.ROLES_EMPTY_DESCRIPTION")}
        emptyAction={create}
        columns={[
          { key: "name", header: t("ADMIN.ORG_UNIT_NAME"), cell: (row) => <a className="font-medium text-brand-700 underline" href={`${PATH}/${String(row.id)}`}>{String(row.name)}</a> },
          { key: "count", header: t("ADMIN.ROLES_PERMISSIONS"), cell: (row) => String(row.permissionCount ?? 0) },
          { key: "mfa", header: t("ADMIN.USERS_MFA"), cell: (row) => (row.requiresMfa ? t("ADMIN.YES") : t("ADMIN.NO")) },
          { key: "status", header: t("ADMIN.STATUS"), cell: (row) => <StatusBadge tone={row.active ? "success" : "neutral"} label={row.active ? t("ADMIN.STATUS_ACTIVE") : t("ADMIN.STATUS_ARCHIVED")} /> },
          {
            key: "actions",
            header: t("ADMIN.ACTIONS"),
            srOnlyHeader: true,
            cell: (row) =>
              mayCreate.allowed && row.active ? (
                <ActionDialog triggerLabel={t("ADMIN.ROLES_CLONE")} title={t("ADMIN.ROLES_CLONE")} submitLabel={t("ADMIN.ROLES_CLONE")} cancelLabel={t("COMMON.CANCEL")} closeLabel={t("COMMON.CLOSE")} action={cloneRoleAction}>
                  <input type="hidden" name="roleId" value={String(row.id)} />
                  <AdminField label={t("ADMIN.ORG_UNIT_NAME")} htmlFor={`clone-${String(row.id)}`} required>
                    <TextInput id={`clone-${String(row.id)}`} name="name" defaultValue={`${String(row.name)} (copy)`} required maxLength={80} />
                  </AdminField>
                </ActionDialog>
              ) : null,
          },
        ]}
      />
      <CursorPager t={t} path={PATH} params={{ search }} cursor={cursor} nextCursor={loaded.data.page.nextCursor} />

      <Panel title={t("ADMIN.WHY_TITLE")}>
        <p className="mb-3 text-sm text-ink-muted">{t("ADMIN.WHY_HELP")}</p>
        <form method="get" className="grid gap-3 sm:grid-cols-2">
          <AdminField label={t("ADMIN.WHY_USER")} htmlFor="why-user" required>
            <Select id="why-user" name="user" required defaultValue={diagUser ?? ""} options={userOptions} placeholder={t("ADMIN.CHOOSE")} />
          </AdminField>
          <AdminField label={t("ADMIN.WHY_PERMISSION")} htmlFor="why-permission" hint={t("ADMIN.WHY_PERMISSION_HINT")}>
            <Select id="why-permission" name="permission" defaultValue={diagPermission ?? ""} options={PERMISSION_CATALOG.map((def) => ({ value: permissionKey(def), label: permissionKey(def) }))} placeholder={t("ADMIN.NONE")} />
          </AdminField>
          <AdminField label={t("ADMIN.WHY_EMPLOYEE_ID")} htmlFor="why-employee" hint={t("ADMIN.WHY_RECORD_HINT")}>
            <TextInput id="why-employee" name="employee" defaultValue={diagEmployee ?? ""} dir="ltr" maxLength={64} />
          </AdminField>
          <AdminField label={t("ADMIN.WHY_UNIT_ID")} htmlFor="why-unit" hint={t("ADMIN.WHY_RECORD_HINT")}>
            <TextInput id="why-unit" name="unit" defaultValue={diagUnit ?? ""} dir="ltr" maxLength={64} />
          </AdminField>
          <div>
            <button type="submit" className="inline-flex rounded border border-line-strong bg-surface px-4 py-2 text-sm font-medium hover:bg-neutral-soft">
              {t("ADMIN.WHY_RUN")}
            </button>
          </div>
        </form>
        {diagnostic && !diagnostic.denied ? (
          <div className="mt-5 space-y-4" aria-live="polite">
            {!diagnostic.data.accountActive ? <p className="text-sm text-danger">{t("ADMIN.WHY_ACCOUNT_INACTIVE")}</p> : null}
            {diagnostic.data.explanation ? (
              <div className="rounded border border-line p-3 text-sm">
                <p className="font-semibold">
                  <StatusBadge tone={diagnostic.data.explanation.decision.allowed ? "success" : "danger"} label={diagnostic.data.explanation.decision.allowed ? t("ADMIN.WHY_ALLOWED") : t("ADMIN.WHY_DENIED")} />{" "}
                  <span dir="ltr">{diagnostic.data.explanation.permission}</span>
                </p>
                <p className="mt-2">
                  {diagnostic.data.explanation.decision.via
                    ? t("ADMIN.WHY_VIA", { role: diagnostic.data.explanation.decision.via.roleName, scope: t(`ADMIN.SCOPE_TYPE_${diagnostic.data.explanation.decision.via.scopeType}`) })
                    : t(`ADMIN.WHY_REASON_${diagnostic.data.explanation.decision.reason}`)}
                </p>
                <ul className="mt-3 space-y-2">
                  {diagnostic.data.explanation.assignments.map((assignment) => (
                    <li key={assignment.roleAssignmentId} className="rounded bg-neutral-soft p-2">
                      <span className="font-medium">{assignment.roleName}</span> · {t(`ADMIN.ASSIGNMENT_STATE_${assignment.status}`)} · {showDateTime(assignment.effectiveFrom, viewer)}
                      {assignment.effectiveTo ? ` → ${showDateTime(assignment.effectiveTo, viewer)}` : ""}
                      {!assignment.conditionMet ? ` · ${t("ADMIN.WHY_CONDITION_NOT_MET")}` : ""}
                      <ul className="ms-4 list-disc">
                        {assignment.scopes.map((scope) => (
                          <li key={scope.scopeId}>
                            {t(`ADMIN.SCOPE_TYPE_${scope.type}`)}: {scope.matched ? t("ADMIN.WHY_SCOPE_MATCHED") : t("ADMIN.WHY_SCOPE_NOT_MATCHED")}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <h3 className="mb-1 font-semibold">{t("ADMIN.WHY_EFFECTIVE")}</h3>
              {diagnostic.data.permissions.length === 0 ? (
                <p className="text-sm text-ink-muted">{t("ADMIN.WHY_NO_PERMISSIONS")}</p>
              ) : (
                <p className="text-sm" dir="ltr">{diagnostic.data.permissions.join(", ")}</p>
              )}
            </div>
          </div>
        ) : null}
      </Panel>
    </AdminPage>
  );
}
