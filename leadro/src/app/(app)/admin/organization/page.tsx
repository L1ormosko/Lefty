import { Select, TextInput } from "@/components/ui";
import { ORG_UNIT_TYPES } from "@/lib/org-hierarchy";
import { can } from "@/server/authz";
import { listOrgUnits } from "@/server/organization";
import { requireFullSession } from "../../../_lib/page-context";
import { ActionDialog } from "../_components/ActionDialog";
import { AdminField } from "../_components/AdminField";
import { AccessDenied, AdminPage, Panel } from "../_components/AdminPage";
import { AdminTable } from "../_components/AdminTable";
import { CursorPager } from "../_components/CursorPager";
import { SearchForm } from "../_components/SearchForm";
import type { SearchParams } from "../_lib/format";
import { loadActiveUnits, loadEmployeeOptions, unitOptions, type UnitSummary } from "../_lib/options";
import { organizationTabs } from "../_lib/org-tabs";
import { loadForPage, queryParam } from "../_lib/page-guard";
import { buildUnitTree } from "../_lib/unit-tree";
import { createUnitAction } from "./actions";
import { UnitDetail } from "./_components/UnitDetail";
import { UnitTree } from "./_components/UnitTree";

const PATH = "/admin/organization";

/**
 * Organization Structure (§3.4): searchable tree of units with the actions that change it. The
 * selected unit (`?unit=`) opens its detail panel. Searching switches to a flat, paged result list.
 */
export default async function OrganizationPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const query = await searchParams;
  const search = queryParam(query, "search");
  const selectedId = queryParam(query, "unit");
  const cursor = queryParam(query, "cursor");
  const peopleCursor = queryParam(query, "people");

  const access = await loadForPage(() => listOrgUnits(actor, { limit: 1, active: "true" }));
  if (access.denied) return <AccessDenied t={t} />;

  const [units, employeeOptions, mayCreate] = await Promise.all([
    loadActiveUnits(actor),
    loadEmployeeOptions(actor),
    can(actor, "organization.create"),
  ]);
  const viewer = { locale, timeZone };
  const searchResults = search ? await listOrgUnits(actor, { limit: 50, cursor, active: "true", search }) : null;
  const keep = { search, unit: selectedId };
  const hrefFor = (unitId: string) => `${PATH}?${new URLSearchParams({ ...(search ? { search } : {}), unit: unitId }).toString()}`;

  const createAction = mayCreate.allowed ? (
    <ActionDialog
      triggerLabel={t("ADMIN.ORG_ADD_UNIT")}
      triggerVariant="primary"
      title={t("ADMIN.ORG_ADD_UNIT")}
      description={t("ADMIN.ORG_ADD_UNIT_HELP")}
      submitLabel={t("COMMON.CREATE")}
      cancelLabel={t("COMMON.CANCEL")}
      closeLabel={t("COMMON.CLOSE")}
      action={createUnitAction}
    >
      <AdminField label={t("ADMIN.ORG_UNIT_TYPE")} htmlFor="create-type" required>
        <Select id="create-type" name="type" required options={ORG_UNIT_TYPES.map((type) => ({ value: type, label: t(`ORG_UNIT_TYPE.${type}`) }))} />
      </AdminField>
      <AdminField label={t("ADMIN.ORG_UNIT_NAME")} htmlFor="create-name" required>
        <TextInput id="create-name" name="name" required maxLength={120} />
      </AdminField>
      <AdminField label={t("ADMIN.ORG_UNIT_CODE")} htmlFor="create-code">
        <TextInput id="create-code" name="code" maxLength={40} dir="ltr" />
      </AdminField>
      <AdminField label={t("ADMIN.ORG_PARENT")} htmlFor="create-parent" hint={t("ADMIN.ORG_PARENT_HINT")}>
        <Select id="create-parent" name="parentId" defaultValue={selectedId ?? ""} options={unitOptions(units, t)} placeholder={t("ADMIN.ORG_TOP_LEVEL")} />
      </AdminField>
    </ActionDialog>
  ) : undefined;

  const emptyAction = createAction;

  return (
    <AdminPage title={t("ADMIN.ORG_TITLE")} intro={t("ADMIN.ORG_INTRO")} primaryAction={createAction} tabs={organizationTabs(t, "structure")}>
      <SearchForm t={t} search={search} hidden={{ unit: selectedId }} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title={t("ADMIN.ORG_TREE")}>
          {searchResults ? (
            <>
              <AdminTable<UnitSummary>
                caption={t("ADMIN.ORG_SEARCH_RESULTS")}
                rows={searchResults.data as unknown as UnitSummary[]}
                getRowId={(row) => row.id}
                emptyTitle={t("ADMIN.ORG_SEARCH_EMPTY_TITLE")}
                emptyDescription={t("ADMIN.ORG_SEARCH_EMPTY_DESCRIPTION")}
                columns={[
                  { key: "name", header: t("ADMIN.ORG_UNIT_NAME"), cell: (row) => <a className="text-brand-700 underline" href={hrefFor(row.id)}>{row.name}</a> },
                  { key: "type", header: t("ADMIN.ORG_UNIT_TYPE"), cell: (row) => t(`ORG_UNIT_TYPE.${row.type}`) },
                ]}
              />
              <div className="mt-3">
                <CursorPager t={t} path={PATH} params={keep} cursor={cursor} nextCursor={searchResults.page.nextCursor} />
              </div>
            </>
          ) : units.length === 0 ? (
            <AdminTable<UnitSummary>
              caption={t("ADMIN.ORG_TREE")}
              rows={[]}
              columns={[]}
              getRowId={(row) => row.id}
              emptyTitle={t("ADMIN.ORG_EMPTY_TITLE")}
              emptyDescription={t("ADMIN.ORG_EMPTY_DESCRIPTION")}
              emptyAction={emptyAction}
            />
          ) : (
            <UnitTree t={t} nodes={buildUnitTree(units)} selectedId={selectedId} hrefFor={hrefFor} />
          )}
        </Panel>
        {selectedId ? (
          <UnitDetail
            actor={actor}
            t={t}
            viewer={viewer}
            unitId={selectedId}
            units={units}
            employeeOptions={employeeOptions}
            cursor={peopleCursor}
            basePath={PATH}
            params={keep}
          />
        ) : (
          <Panel>
            <p className="text-sm text-ink-muted">{t("ADMIN.ORG_SELECT_UNIT")}</p>
          </Panel>
        )}
      </div>
    </AdminPage>
  );
}
