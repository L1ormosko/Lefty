import { Select, StatusBadge, TextInput } from "@/components/ui";
import { can } from "@/server/authz";
import { listUsers, listInvitations, type InvitationState } from "@/server/users";
import { requireFullSession } from "../../../_lib/page-context";
import { ActionDialog } from "../_components/ActionDialog";
import { AdminField } from "../_components/AdminField";
import { AccessDenied, AdminPage, Panel } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { CursorPager } from "../_components/CursorPager";
import { InviteDialog } from "../_components/InviteDialog";
import { SearchForm } from "../_components/SearchForm";
import { fullNameOf, showDateTime, toneOfStatus, type SearchParams } from "../_lib/format";
import { loadActiveUnits, loadEmployeeOptions, loadLegalEntityOptions, loadRoleOptions, unitOptions } from "../_lib/options";
import { loadForPage, queryParam } from "../_lib/page-guard";
import { deactivateUserAction } from "./actions";

const PATH = "/admin/users";
const STATUSES = ["INVITED", "ACTIVE", "LOCKED", "DEACTIVATED"] as const;
type Status = (typeof STATUSES)[number];

const invitationTone = (state: InvitationState) => (state === "PENDING" ? "info" : state === "ACCEPTED" ? "success" : state === "REVOKED" ? "danger" : "neutral");

/** Users & invitations (§22): logins in the caller's scope, pending invitations, invite and deactivate. */
export default async function UsersPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const query = await searchParams;
  const search = queryParam(query, "search");
  const statusParam = queryParam(query, "status");
  const status = STATUSES.find((candidate) => candidate === statusParam) as Status | undefined;
  const pendingDeactivation = queryParam(query, "pendingDeactivation") === "true";
  const cursor = queryParam(query, "cursor");
  const invitationCursor = queryParam(query, "icursor");
  const viewer = { locale, timeZone };

  const loaded = await loadForPage(() => listUsers(actor, { limit: 25, cursor, search, status, pendingDeactivation: pendingDeactivation ? "true" : undefined }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const invitations = await loadForPage(() => listInvitations(actor, { limit: 10, cursor: invitationCursor }));

  const [units, legalEntities, roleOptions, employeeOptions, mayInvite, mayDeactivate] = await Promise.all([
    loadActiveUnits(actor),
    loadLegalEntityOptions(actor),
    loadRoleOptions(actor),
    loadEmployeeOptions(actor, { withoutLogin: true }),
    can(actor, "users.create"),
    can(actor, "users.archive"),
  ]);
  const dash = (value: unknown) => (value === undefined || value === null || value === "" ? "—" : String(value));
  const inviteProps = { t, roleOptions, unitOptions: unitOptions(units, t), legalEntityOptions: legalEntities };
  const invite = mayInvite.allowed ? <InviteDialog {...inviteProps} variant="primary" employeeOptions={employeeOptions} /> : undefined;

  return (
    <AdminPage title={t("ADMIN.USERS_TITLE")} intro={t("ADMIN.USERS_INTRO")} primaryAction={invite}>
      <SearchForm t={t} search={search}>
        <div className="min-w-40">
          <label htmlFor="filter-user-status" className="sr-only">
            {t("ADMIN.STATUS")}
          </label>
          <Select id="filter-user-status" name="status" defaultValue={status ?? ""} placeholder={t("ADMIN.ALL_STATUSES")} options={STATUSES.map((value) => ({ value, label: t(`ADMIN.USER_STATUS_${value}`) }))} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="pendingDeactivation" value="true" defaultChecked={pendingDeactivation} />
          {t("ADMIN.USERS_PENDING_DEACTIVATION")}
        </label>
      </SearchForm>
      <AdminTable
        caption={t("ADMIN.USERS_TITLE")}
        rows={loaded.data.data}
        getRowId={(row) => String(row.id)}
        emptyTitle={t("ADMIN.USERS_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.USERS_EMPTY_DESCRIPTION")}
        emptyAction={search || status || pendingDeactivation ? undefined : invite}
        columns={[
          { key: "email", header: t("ADMIN.EMPLOYEE_EMAIL"), cell: (row) => <span dir="ltr">{dash(row.email)}</span> },
          {
            key: "name",
            header: t("ADMIN.EMPLOYEE_NAME"),
            cell: (row) =>
              row.employeeId ? (
                <a className="text-brand-700 underline" href={`/admin/employees/${String(row.employeeId)}`}>
                  {fullNameOf(row) || String(row.employeeId)}
                </a>
              ) : (
                t("ADMIN.USERS_NO_EMPLOYEE")
              ),
          },
          {
            key: "status",
            header: t("ADMIN.STATUS"),
            cell: (row) => (
              <div className="space-y-1">
                <StatusBadge tone={toneOfStatus(String(row.status))} label={t(`ADMIN.USER_STATUS_${String(row.status)}`)} />
                {row.loginPendingDeactivation ? <StatusBadge tone="warning" label={t("ADMIN.USERS_PENDING_DEACTIVATION_BADGE")} /> : null}
              </div>
            ),
          },
          { key: "mfa", header: t("ADMIN.USERS_MFA"), cell: (row) => (row.mfaEnabled ? t("ADMIN.YES") : t("ADMIN.NO")) },
          { key: "last", header: t("ADMIN.USERS_LAST_LOGIN"), cell: (row) => (row.lastLoginAt ? showDateTime(row.lastLoginAt, viewer) : t("ADMIN.USERS_NEVER")) },
          {
            key: "actions",
            header: t("ADMIN.ACTIONS"),
            srOnlyHeader: true,
            cell: (row) =>
              mayDeactivate.allowed && row.status !== "DEACTIVATED" && row.id !== actor.userId ? (
                <ActionDialog
                  triggerLabel={t("ADMIN.USERS_DEACTIVATE")}
                  triggerVariant="danger"
                  title={t("ADMIN.USERS_DEACTIVATE_TITLE", { email: dash(row.email) })}
                  description={t("ADMIN.USERS_DEACTIVATE_HELP")}
                  submitLabel={t("ADMIN.USERS_DEACTIVATE")}
                  cancelLabel={t("COMMON.CANCEL")}
                  closeLabel={t("COMMON.CLOSE")}
                  destructive
                  action={deactivateUserAction}
                >
                  <input type="hidden" name="userId" value={String(row.id)} />
                  <AdminField label={t("ADMIN.REASON")} htmlFor={`deactivate-${String(row.id)}`} required>
                    <TextInput id={`deactivate-${String(row.id)}`} name="reason" required maxLength={500} />
                  </AdminField>
                </ActionDialog>
              ) : null,
          },
        ]}
      />
      <CursorPager t={t} path={PATH} params={{ search, status, pendingDeactivation: pendingDeactivation ? "true" : undefined, icursor: invitationCursor }} cursor={cursor} nextCursor={loaded.data.page.nextCursor} />

      {invitations.denied ? null : (
        <Panel title={t("ADMIN.INVITATIONS_TITLE")}>
          <AdminTable
            caption={t("ADMIN.INVITATIONS_TITLE")}
            rows={invitations.data.data}
            getRowId={(row) => row.id}
            emptyTitle={t("ADMIN.INVITATIONS_EMPTY_TITLE")}
            emptyDescription={t("ADMIN.INVITATIONS_EMPTY_DESCRIPTION")}
            columns={[
              { key: "email", header: t("ADMIN.EMPLOYEE_EMAIL"), cell: (row) => <span dir="ltr">{row.email}</span> },
              { key: "employee", header: t("ADMIN.ORG_EMPLOYEE"), cell: (row) => row.employeeName ?? "—" },
              { key: "role", header: t("ADMIN.INVITE_ROLE"), cell: (row) => row.roleName ?? t("ADMIN.INVITE_NO_ROLE") },
              { key: "by", header: t("ADMIN.INVITATIONS_INVITED_BY"), cell: (row) => row.invitedByName ?? "—" },
              { key: "sent", header: t("ADMIN.INVITATIONS_SENT"), cell: (row) => showDateTime(row.createdAt, viewer) },
              { key: "expires", header: t("ADMIN.INVITATIONS_EXPIRES"), cell: (row) => showDateTime(row.expiresAt, viewer) },
              { key: "state", header: t("ADMIN.STATUS"), cell: (row) => <StatusBadge tone={invitationTone(row.state)} label={t(`ADMIN.INVITATION_STATE_${row.state}`)} /> },
              {
                key: "actions",
                header: t("ADMIN.ACTIONS"),
                srOnlyHeader: true,
                cell: (row) =>
                  mayInvite.allowed && row.employeeId && (row.state === "EXPIRED" || row.state === "PENDING") ? (
                    <InviteDialog {...inviteProps} employeeId={row.employeeId} defaultEmail={row.email} />
                  ) : null,
              },
            ]}
          />
          <div className="mt-3">
            <CursorPager t={t} path={PATH} params={{ search, status, cursor }} cursor={invitationCursor} nextCursor={invitations.data.page.nextCursor} cursorParam="icursor" />
          </div>
          <p className="mt-3 text-xs text-ink-muted">{t("ADMIN.INVITATIONS_NOTE")}</p>
        </Panel>
      )}
    </AdminPage>
  );
}
