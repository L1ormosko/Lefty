import { Select, StatusBadge, TextInput } from "@/components/ui";
import { SUPPORTED_LOCALES } from "@/lib/i18n";
import { can } from "@/server/authz";
import { listOverridesAsActor } from "@/server/i18n";
import { requireFullSession } from "../../../_lib/page-context";
import { ActionDialog } from "../_components/ActionDialog";
import { AdminField } from "../_components/AdminField";
import { AccessDenied, AdminPage } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { ConfirmActionButton } from "../_components/ConfirmActionButton";
import { CursorPager } from "../_components/CursorPager";
import { localeLabel, localeOptions, showDateTime, type SearchParams } from "../_lib/format";
import { loadForPage, queryParam } from "../_lib/page-guard";
import { deleteOverrideAction, reviewOverrideAction, saveOverrideAction } from "./actions";

const PATH = "/admin/localization";

/**
 * Translation overrides (§16.6): a company may reword built-in texts; an edit is served only after a
 * DIFFERENT person reviews it, and the review is bound to the exact text shown here.
 */
export default async function LocalizationPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const query = await searchParams;
  const cursor = queryParam(query, "cursor");
  const localeFilter = SUPPORTED_LOCALES.find((value) => value === queryParam(query, "locale"));
  const stateParam = queryParam(query, "state");
  const reviewed = stateParam === "reviewed" ? true : stateParam === "pending" ? false : undefined;
  const viewer = { locale, timeZone };

  const loaded = await loadForPage(() => listOverridesAsActor(actor, { limit: 25, cursor, locale: localeFilter, reviewed }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const [mayEdit, mayReview] = await Promise.all([can(actor, "localization.edit"), can(actor, "localization.configure")]);
  const dialog = { cancelLabel: t("COMMON.CANCEL"), closeLabel: t("COMMON.CLOSE") };

  const add = mayEdit.allowed ? (
    <ActionDialog triggerLabel={t("ADMIN.LOCALIZATION_ADD")} triggerVariant="primary" title={t("ADMIN.LOCALIZATION_ADD")} description={t("ADMIN.LOCALIZATION_ADD_HELP")} submitLabel={t("COMMON.SAVE")} action={saveOverrideAction} {...dialog}>
      <AdminField label={t("COMMON.LANGUAGE")} htmlFor="ov-locale" required>
        <Select id="ov-locale" name="locale" required options={localeOptions(t)} placeholder={t("ADMIN.CHOOSE")} />
      </AdminField>
      <AdminField label={t("ADMIN.LOCALIZATION_KEY")} htmlFor="ov-key" required>
        <TextInput id="ov-key" name="key" required dir="ltr" maxLength={200} />
      </AdminField>
      <AdminField label={t("ADMIN.LOCALIZATION_TEXT")} htmlFor="ov-value" hint={t("ADMIN.LOCALIZATION_PLACEHOLDER_HINT")} required>
        <TextInput id="ov-value" name="value" required maxLength={2000} />
      </AdminField>
    </ActionDialog>
  ) : undefined;

  return (
    <AdminPage title={t("ADMIN.LOCALIZATION_TITLE")} intro={t("ADMIN.LOCALIZATION_INTRO")} primaryAction={add}>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="min-w-40">
          <label htmlFor="filter-locale" className="sr-only">{t("COMMON.LANGUAGE")}</label>
          <Select id="filter-locale" name="locale" defaultValue={localeFilter ?? ""} options={localeOptions(t)} placeholder={t("ADMIN.LOCALIZATION_ALL_LANGUAGES")} />
        </div>
        <div className="min-w-40">
          <label htmlFor="filter-state" className="sr-only">{t("ADMIN.STATUS")}</label>
          <Select id="filter-state" name="state" defaultValue={stateParam ?? ""} placeholder={t("ADMIN.ALL_STATUSES")} options={[{ value: "pending", label: t("ADMIN.LOCALIZATION_PENDING") }, { value: "reviewed", label: t("ADMIN.LOCALIZATION_LIVE") }]} />
        </div>
        <button type="submit" className="inline-flex rounded border border-line-strong bg-surface px-4 py-2 text-sm font-medium hover:bg-neutral-soft">{t("COMMON.FILTER")}</button>
      </form>
      <AdminTable
        caption={t("ADMIN.LOCALIZATION_TITLE")}
        rows={loaded.data.data}
        getRowId={(row) => row.id}
        emptyTitle={t("ADMIN.LOCALIZATION_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.LOCALIZATION_EMPTY_DESCRIPTION")}
        emptyAction={add}
        columns={[
          { key: "key", header: t("ADMIN.LOCALIZATION_KEY"), cell: (row) => <span dir="ltr">{row.key}</span> },
          { key: "locale", header: t("COMMON.LANGUAGE"), cell: (row) => localeLabel(t, row.locale) },
          { key: "builtin", header: t("ADMIN.LOCALIZATION_BUILT_IN"), cell: (row) => row.builtIn ?? t("ADMIN.NOT_AVAILABLE") },
          { key: "override", header: t("ADMIN.LOCALIZATION_TEXT"), cell: (row) => row.value },
          { key: "status", header: t("ADMIN.STATUS"), cell: (row) => <StatusBadge tone={row.reviewed ? "success" : "warning"} label={row.reviewed ? t("ADMIN.LOCALIZATION_LIVE") : t("ADMIN.LOCALIZATION_PENDING")} /> },
          { key: "updated", header: t("ADMIN.LOCALIZATION_UPDATED"), cell: (row) => showDateTime(row.updatedAt, viewer) },
          {
            key: "actions",
            header: t("ADMIN.ACTIONS"),
            srOnlyHeader: true,
            cell: (row) => (
              <div className="flex flex-wrap items-center gap-2">
                {mayEdit.allowed ? (
                  <ActionDialog triggerLabel={t("COMMON.EDIT")} title={t("ADMIN.LOCALIZATION_EDIT", { key: row.key })} description={t("ADMIN.LOCALIZATION_EDIT_HELP")} submitLabel={t("COMMON.SAVE")} action={saveOverrideAction} {...dialog}>
                    <input type="hidden" name="locale" value={row.locale} />
                    <input type="hidden" name="key" value={row.key} />
                    <AdminField label={t("ADMIN.LOCALIZATION_TEXT")} htmlFor={`ov-edit-${row.id}`} hint={t("ADMIN.LOCALIZATION_PLACEHOLDER_HINT")} required>
                      <TextInput id={`ov-edit-${row.id}`} name="value" defaultValue={row.value} required maxLength={2000} />
                    </AdminField>
                  </ActionDialog>
                ) : null}
                {mayReview.allowed && !row.reviewed && row.updatedById !== actor.userId ? (
                  <ActionDialog triggerLabel={t("ADMIN.LOCALIZATION_REVIEW")} title={t("ADMIN.LOCALIZATION_REVIEW_TITLE", { key: row.key })} description={t("ADMIN.LOCALIZATION_REVIEW_HELP")} submitLabel={t("ADMIN.LOCALIZATION_APPROVE")} action={reviewOverrideAction} {...dialog}>
                    <input type="hidden" name="locale" value={row.locale} />
                    <input type="hidden" name="key" value={row.key} />
                    <input type="hidden" name="reviewedValue" value={row.value} />
                    <blockquote className="rounded border border-line bg-neutral-soft p-3 text-sm">{row.value}</blockquote>
                  </ActionDialog>
                ) : null}
                {mayReview.allowed ? (
                  <ConfirmActionButton triggerLabel={t("COMMON.DELETE")} triggerVariant="danger" title={t("ADMIN.LOCALIZATION_DELETE_TITLE", { key: row.key })} description={t("ADMIN.LOCALIZATION_DELETE_HELP")} confirmLabel={t("COMMON.DELETE")} cancelLabel={t("COMMON.CANCEL")} destructive action={deleteOverrideAction} fields={{ locale: row.locale, key: row.key }} />
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <CursorPager t={t} path={PATH} params={{ locale: localeFilter, state: stateParam }} cursor={cursor} nextCursor={loaded.data.page.nextCursor} />
    </AdminPage>
  );
}
