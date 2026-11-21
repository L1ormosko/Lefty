import { Select, StatusBadge, TextInput } from "@/components/ui";
import { can } from "@/server/authz";
import { getCompanyOverview, getTenantProfile, listLegalEntities } from "@/server/organization";
import { requireFullSession } from "../../../_lib/page-context";
import { AdminField } from "../_components/AdminField";
import { ActionDialog } from "../_components/ActionDialog";
import { AccessDenied, AdminPage, LinkButton, Panel } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { knownTimeZones, localeLabel, localeOptions, showDateTime } from "../_lib/format";
import { loadForPage } from "../_lib/page-guard";
import { createLegalEntityAction, updateCompanyProfileAction } from "./actions";

/** Company Overview (§3.4): identity, legal entities, active states, counts, defaults, module status. */
export default async function CompanyOverviewPage() {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const loaded = await loadForPage(async () => ({
    profile: await getTenantProfile(actor),
    overview: await getCompanyOverview(actor),
  }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const { profile, overview } = loaded.data;

  // Legal entities need organization.view; a company-settings viewer without it simply sees none.
  const entities = await loadForPage(() => listLegalEntities(actor, { limit: 50, active: "all" }));
  const legalEntities = entities.denied ? [] : entities.data.data;

  const [mayEdit, mayAddEntity] = await Promise.all([
    can(actor, "company_settings.edit"),
    can(actor, "organization.create"),
  ]);
  const dialogLabels = { cancelLabel: t("COMMON.CANCEL"), closeLabel: t("COMMON.CLOSE"), submitLabel: t("COMMON.SAVE") };
  const viewer = { locale, timeZone };

  const counts = [
    { id: "employees", label: t("ADMIN.COMPANY_EMPLOYEES"), value: overview.activeEmployeeCount },
    { id: "branches", label: t("ADMIN.COMPANY_BRANCHES"), value: overview.activeBranchCount },
    { id: "entities", label: t("ADMIN.COMPANY_LEGAL_ENTITIES"), value: overview.activeLegalEntityCount },
    { id: "states", label: t("ADMIN.COMPANY_STATES"), value: overview.activeStates.length },
  ];

  return (
    <AdminPage
      title={t("ADMIN.COMPANY_TITLE")}
      intro={t("ADMIN.COMPANY_INTRO")}
      primaryAction={
        mayEdit.allowed ? (
          <ActionDialog
            triggerLabel={t("ADMIN.COMPANY_EDIT_PROFILE")}
            triggerVariant="primary"
            title={t("ADMIN.COMPANY_EDIT_PROFILE")}
            action={updateCompanyProfileAction}
            {...dialogLabels}
          >
            <AdminField label={t("ADMIN.COMPANY_NAME")} htmlFor="company-name" required>
              <TextInput id="company-name" name="name" defaultValue={String(profile.name ?? "")} required maxLength={120} />
            </AdminField>
          </ActionDialog>
        ) : null
      }
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {counts.map((count) => (
          <div key={count.id} className="rounded border border-line bg-surface p-4">
            <dt className="text-sm text-ink-muted">{count.label}</dt>
            <dd className="mt-1 text-3xl font-bold">{count.value}</dd>
          </div>
        ))}
      </dl>

      <Panel
        title={t("ADMIN.COMPANY_IDENTITY")}
        action={<LinkButton href="/admin/organization">{t("ADMIN.COMPANY_VIEW_STRUCTURE")}</LinkButton>}
      >
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">{t("ADMIN.COMPANY_NAME")}</dt>
            <dd className="font-medium">{String(profile.name ?? "")}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("AUTH.COMPANY_CODE")}</dt>
            <dd className="font-medium" dir="ltr">
              {String(profile.slug ?? "")}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("ADMIN.COMPANY_CREATED")}</dt>
            <dd className="font-medium">{showDateTime(profile.createdAt, viewer)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("ADMIN.COMPANY_ACTIVE_STATES")}</dt>
            <dd className="font-medium">
              {overview.activeStates.length === 0 ? t("ADMIN.NONE") : overview.activeStates.map((state) => state.name).join(", ")}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title={t("ADMIN.COMPANY_DEFAULTS")}
        action={
          mayEdit.allowed ? (
            <ActionDialog
              triggerLabel={t("ADMIN.COMPANY_CONFIGURE_DEFAULTS")}
              title={t("ADMIN.COMPANY_CONFIGURE_DEFAULTS")}
              description={t("ADMIN.COMPANY_DEFAULTS_HELP")}
              action={updateCompanyProfileAction}
              {...dialogLabels}
            >
              <AdminField label={t("COMMON.LANGUAGE")} htmlFor="company-locale" required>
                <Select
                  id="company-locale"
                  name="defaultLocale"
                  defaultValue={String(profile.defaultLocale ?? "en-US")}
                  options={localeOptions(t)}
                  required
                />
              </AdminField>
              <AdminField label={t("ADMIN.COMPANY_TIME_ZONE")} htmlFor="company-zone" hint={t("ADMIN.COMPANY_TIME_ZONE_HINT")} required>
                <TextInput id="company-zone" name="defaultTimeZone" list="company-zones" defaultValue={String(profile.defaultTimeZone ?? "")} required dir="ltr" />
                <datalist id="company-zones">
                  {knownTimeZones().map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </AdminField>
            </ActionDialog>
          ) : null
        }
      >
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">{t("COMMON.LANGUAGE")}</dt>
            <dd className="font-medium">{localeLabel(t, profile.defaultLocale)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t("ADMIN.COMPANY_TIME_ZONE")}</dt>
            <dd className="font-medium" dir="ltr">
              {String(profile.defaultTimeZone ?? "")}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title={t("ADMIN.COMPANY_LEGAL_ENTITIES")}
        action={
          mayAddEntity.allowed ? (
            <ActionDialog
              triggerLabel={t("ADMIN.COMPANY_ADD_LEGAL_ENTITY")}
              title={t("ADMIN.COMPANY_ADD_LEGAL_ENTITY")}
              action={createLegalEntityAction}
              submitLabel={t("COMMON.CREATE")}
              cancelLabel={t("COMMON.CANCEL")}
              closeLabel={t("COMMON.CLOSE")}
            >
              <AdminField label={t("ADMIN.COMPANY_ENTITY_NAME")} htmlFor="entity-name" required>
                <TextInput id="entity-name" name="name" required maxLength={120} />
              </AdminField>
              <AdminField label={t("ADMIN.COMPANY_ENTITY_LEGAL_NAME")} htmlFor="entity-legal-name">
                <TextInput id="entity-legal-name" name="legalName" maxLength={200} />
              </AdminField>
            </ActionDialog>
          ) : null
        }
      >
        <AdminTable
          caption={t("ADMIN.COMPANY_LEGAL_ENTITIES")}
          rows={legalEntities}
          getRowId={(row) => String(row.id)}
          emptyTitle={t("ADMIN.COMPANY_ENTITIES_EMPTY_TITLE")}
          emptyDescription={t("ADMIN.COMPANY_ENTITIES_EMPTY_DESCRIPTION")}
          columns={[
            { key: "name", header: t("ADMIN.COMPANY_ENTITY_NAME"), cell: (row) => String(row.name ?? "") },
            { key: "legalName", header: t("ADMIN.COMPANY_ENTITY_LEGAL_NAME"), cell: (row) => String(row.legalName ?? "—") },
            {
              key: "status",
              header: t("ADMIN.STATUS"),
              cell: (row) => (
                <StatusBadge tone={row.active ? "success" : "neutral"} label={row.active ? t("ADMIN.STATUS_ACTIVE") : t("ADMIN.STATUS_ARCHIVED")} />
              ),
            },
          ]}
        />
      </Panel>

      <Panel title={t("ADMIN.COMPANY_SUBSCRIPTION")}>
        <p className="text-sm text-ink-muted">{t("ADMIN.COMPANY_SUBSCRIPTION_NONE")}</p>
      </Panel>
    </AdminPage>
  );
}
