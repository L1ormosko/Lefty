import Link from "next/link";
import { DatePicker, Select, StatusBadge, TextInput } from "@/components/ui";
import { can } from "@/server/authz";
import { getRole, getRoleHistory, listRoleAssignments } from "@/server/roles";
import { listUsers } from "@/server/users";
import { requireFullSession } from "../../../../_lib/page-context";
import { ActionDialog } from "../../_components/ActionDialog";
import { AdminField } from "../../_components/AdminField";
import { AccessDenied, AdminPage, Panel } from "../../_components/AdminPage";
import { AdminTable } from "../../_components/AdminTable";
import { CursorPager } from "../../_components/CursorPager";
import { ScopeFields } from "../../_components/ScopeFields";
import { fullNameOf, showDateTime, toneOfStatus, type SearchParams } from "../../_lib/format";
import { loadActiveUnits, loadLegalEntityOptions, unitOptions } from "../../_lib/options";
import { loadForPage, queryParam } from "../../_lib/page-guard";
import { PermissionGrid } from "../_components/PermissionGrid";
import { archiveRoleAction, grantRoleAction, revokeAssignmentAction, saveRoleAction } from "../actions";

/** Role detail: permission grid, assignments (grant with scope + expiry, revoke) and permission history. */
export default async function RoleDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const { id } = await params;
  const cursor = queryParam(await searchParams, "cursor");
  const viewer = { locale, timeZone };

  const loaded = await loadForPage(async () => ({
    role: (await getRole(actor, id)) as { id: string; name: string; description: string | null; active: boolean; requiresMfa: boolean; permissions: Array<{ permission: string }> },
    assignments: await listRoleAssignments(actor, { roleId: id, state: "all", limit: 50 }),
    history: await getRoleHistory(actor, id, { limit: 20, cursor }),
  }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const { role, assignments, history } = loaded.data;

  const [users, units, entities, mayEdit, mayArchive, mayAssign] = await Promise.all([
    listUsers(actor, { limit: 200 }).catch(() => null),
    loadActiveUnits(actor),
    loadLegalEntityOptions(actor),
    can(actor, "permissions.edit"),
    can(actor, "permissions.archive"),
    can(actor, "permissions.assign"),
  ]);
  const userOptions = (users?.data ?? []).map((user) => ({ value: String(user.id), label: `${fullNameOf(user) || "—"} (${String(user.email)})` }));
  const userLabel = new Map(userOptions.map((option) => [option.value, option.label]));
  const dialog = { cancelLabel: t("COMMON.CANCEL"), closeLabel: t("COMMON.CLOSE") };

  const save = mayEdit.allowed && role.active ? (
    <ActionDialog triggerLabel={t("COMMON.EDIT")} triggerVariant="primary" title={t("ADMIN.ROLES_EDIT")} submitLabel={t("COMMON.SAVE")} action={saveRoleAction} {...dialog}>
      <input type="hidden" name="roleId" value={id} />
      <AdminField label={t("ADMIN.ORG_UNIT_NAME")} htmlFor="edit-role-name" required>
        <TextInput id="edit-role-name" name="name" defaultValue={role.name} required maxLength={80} />
      </AdminField>
      <AdminField label={t("ADMIN.ROLES_DESCRIPTION")} htmlFor="edit-role-desc">
        <TextInput id="edit-role-desc" name="description" defaultValue={role.description ?? ""} maxLength={500} />
      </AdminField>
      <PermissionGrid t={t} selected={new Set(role.permissions.map((grant) => grant.permission))} idPrefix="edit-role" />
      <AdminField label={t("ADMIN.REASON")} htmlFor="edit-role-reason">
        <TextInput id="edit-role-reason" name="reason" maxLength={500} />
      </AdminField>
    </ActionDialog>
  ) : undefined;

  return (
    <AdminPage title={role.name} intro={role.description ?? undefined} primaryAction={save}>
      <p className="text-sm">
        <Link className="text-brand-700 underline" href="/admin/roles">{t("ADMIN.ROLES_BACK")}</Link>
      </p>
      <Panel
        title={t("ADMIN.ROLES_PERMISSIONS")}
        action={
          <>
            <StatusBadge tone={role.active ? "success" : "neutral"} label={role.active ? t("ADMIN.STATUS_ACTIVE") : t("ADMIN.STATUS_ARCHIVED")} />
            {mayArchive.allowed && role.active ? (
              <ActionDialog triggerLabel={t("COMMON.ARCHIVE")} triggerVariant="danger" title={t("ADMIN.ROLES_ARCHIVE_TITLE", { name: role.name })} description={t("ADMIN.ROLES_ARCHIVE_HELP")} submitLabel={t("COMMON.ARCHIVE")} destructive action={archiveRoleAction} {...dialog}>
                <input type="hidden" name="roleId" value={id} />
                <AdminField label={t("ADMIN.REASON")} htmlFor="archive-role-reason" required>
                  <TextInput id="archive-role-reason" name="reason" required maxLength={500} />
                </AdminField>
              </ActionDialog>
            ) : null}
          </>
        }
      >
        <p className="mb-2 text-sm text-ink-muted">{role.requiresMfa ? t("ADMIN.ROLES_MFA_REQUIRED") : t("ADMIN.ROLES_MFA_OPTIONAL")}</p>
        {role.permissions.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("ADMIN.ROLES_NO_PERMISSIONS")}</p>
        ) : (
          <p className="text-sm" dir="ltr">{role.permissions.map((grant) => grant.permission).join(", ")}</p>
        )}
      </Panel>

      <Panel
        title={t("ADMIN.ROLES_ASSIGNMENTS")}
        action={
          mayAssign.allowed && role.active ? (
            <ActionDialog triggerLabel={t("ADMIN.ROLES_GRANT")} title={t("ADMIN.ROLES_GRANT")} submitLabel={t("COMMON.ASSIGN")} action={grantRoleAction} {...dialog}>
              <input type="hidden" name="roleId" value={id} />
              <AdminField label={t("ADMIN.WHY_USER")} htmlFor="grant-user" required>
                <Select id="grant-user" name="userId" required options={userOptions} placeholder={t("ADMIN.CHOOSE")} />
              </AdminField>
              <ScopeFields t={t} idPrefix="grant" unitOptions={unitOptions(units, t)} legalEntityOptions={entities} required />
              <AdminField label={t("ADMIN.ROLES_EXPIRES")} htmlFor="grant-expiry" hint={t("ADMIN.ROLES_EXPIRES_HINT")}>
                <DatePicker id="grant-expiry" name="effectiveTo" />
              </AdminField>
              <AdminField label={t("ADMIN.REASON")} htmlFor="grant-reason" required>
                <TextInput id="grant-reason" name="reason" required maxLength={500} />
              </AdminField>
            </ActionDialog>
          ) : undefined
        }
      >
        <AdminTable
          caption={t("ADMIN.ROLES_ASSIGNMENTS")}
          rows={assignments.data}
          getRowId={(row) => String(row.id)}
          emptyTitle={t("ADMIN.ROLES_ASSIGNMENTS_EMPTY_TITLE")}
          emptyDescription={t("ADMIN.ROLES_ASSIGNMENTS_EMPTY_DESCRIPTION")}
          columns={[
            { key: "user", header: t("ADMIN.WHY_USER"), cell: (row) => userLabel.get(String(row.userId)) ?? String(row.userId) },
            { key: "scope", header: t("ADMIN.SCOPE_TITLE"), cell: (row) => ((row.scopes as Array<{ type: string }> | undefined) ?? []).map((scope) => t(`ADMIN.SCOPE_TYPE_${scope.type}`)).join(", ") || "—" },
            { key: "state", header: t("ADMIN.STATUS"), cell: (row) => <StatusBadge tone={toneOfStatus(String(row.state))} label={t(`ADMIN.ASSIGNMENT_STATE_${String(row.state)}`)} /> },
            { key: "from", header: t("ADMIN.EFFECTIVE_FROM"), cell: (row) => showDateTime(row.effectiveFrom, viewer) },
            { key: "to", header: t("ADMIN.ROLES_EXPIRES"), cell: (row) => (row.effectiveTo ? showDateTime(row.effectiveTo, viewer) : t("ADMIN.NONE")) },
            { key: "reason", header: t("ADMIN.REASON"), cell: (row) => String(row.reason ?? "—") },
            {
              key: "actions",
              header: t("ADMIN.ACTIONS"),
              srOnlyHeader: true,
              cell: (row) =>
                mayAssign.allowed && (row.state === "ACTIVE" || row.state === "SCHEDULED") ? (
                  <ActionDialog triggerLabel={t("ADMIN.ROLES_REVOKE")} triggerVariant="danger" title={t("ADMIN.ROLES_REVOKE")} submitLabel={t("ADMIN.ROLES_REVOKE")} destructive action={revokeAssignmentAction} {...dialog}>
                    <input type="hidden" name="assignmentId" value={String(row.id)} />
                    <input type="hidden" name="roleId" value={id} />
                    <AdminField label={t("ADMIN.REASON")} htmlFor={`revoke-${String(row.id)}`} required>
                      <TextInput id={`revoke-${String(row.id)}`} name="reason" required maxLength={500} />
                    </AdminField>
                  </ActionDialog>
                ) : null,
            },
          ]}
        />
      </Panel>

      <Panel title={t("ADMIN.ROLES_HISTORY")}>
        <AdminTable
          caption={t("ADMIN.ROLES_HISTORY")}
          rows={history.data}
          getRowId={(row) => row.id}
          emptyTitle={t("ADMIN.HISTORY_EMPTY_TITLE")}
          emptyDescription={t("ADMIN.HISTORY_EMPTY_DESCRIPTION")}
          columns={[
            { key: "when", header: t("ADMIN.HISTORY_WHEN"), cell: (row) => showDateTime(row.occurredAt, viewer) },
            { key: "action", header: t("ADMIN.HISTORY_CHANGE"), cell: (row) => <span dir="ltr">{row.action}</span> },
            { key: "reason", header: t("ADMIN.REASON"), cell: (row) => row.reason ?? "—" },
          ]}
        />
        <div className="mt-3">
          <CursorPager t={t} path={`/admin/roles/${id}`} params={{}} cursor={cursor} nextCursor={history.page.nextCursor} />
        </div>
      </Panel>
    </AdminPage>
  );
}
