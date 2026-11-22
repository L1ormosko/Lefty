import { Select, StatusBadge } from "@/components/ui";
import { can } from "@/server/authz";
import { listEmployees } from "@/server/employees";
import { listOrgUnits, listUnitManagers } from "@/server/organization";
import { requireFullSession } from "../../../../_lib/page-context";
import { ActionDialog } from "../../_components/ActionDialog";
import { AdminField } from "../../_components/AdminField";
import { AccessDenied, AdminPage } from "../../_components/AdminPage";
import { AdminTable } from "../../_components/AdminTable";
import { CursorPager } from "../../_components/CursorPager";
import { SearchForm } from "../../_components/SearchForm";
import { WEEKDAYS } from "../../_lib/branch-form";
import { fullNameOf, type SearchParams } from "../../_lib/format";
import { loadActiveUnits, loadLegalEntityOptions, unitOptions, type UnitSummary, forbiddenAsNull } from "../../_lib/options";
import { organizationTabs } from "../../_lib/org-tabs";
import { loadForPage, queryParam } from "../../_lib/page-guard";
import { ancestorsOf } from "../../_lib/unit-tree";
import { createBranchAction, updateBranchAction } from "./actions";
import { BranchFields, type BranchDefaults } from "./_components/BranchFields";

const PATH = "/admin/organization/branches";
const PAGE_SIZE = 20;

type Hours = Record<string, { open?: string; close?: string } | null> | null;

/** "Mon–Fri 08:00–17:00" style summary is overkill here: list each open day compactly. */
function hoursSummary(hours: Hours, t: (key: string) => string): string {
  if (!hours) return "—";
  const open = WEEKDAYS.filter((day) => hours[day]);
  if (open.length === 0) return t("ADMIN.BRANCH_CLOSED_ALWAYS");
  return open.map((day) => `${t(`ADMIN.WEEKDAY_${day.toUpperCase()}`)} ${hours[day]?.open}–${hours[day]?.close}`).join(" · ");
}

function addressSummary(address: unknown): string {
  if (!address || typeof address !== "object") return "—";
  const a = address as Record<string, string | undefined>;
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" · ") || "—";
}

/** Branch Management (§3.4): one row per branch with address, place in the tree, manager, people and hours. */
export default async function BranchesPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t } = await requireFullSession();
  const query = await searchParams;
  const search = queryParam(query, "search");
  const cursor = queryParam(query, "cursor");

  const loaded = await loadForPage(() => listOrgUnits(actor, { limit: PAGE_SIZE, cursor, active: "all", type: "BRANCH", search }));
  if (loaded.denied) return <AccessDenied t={t} />;
  const branches = loaded.data.data as unknown as UnitSummary[];

  const [allUnits, legalEntities, mayCreate, mayEdit] = await Promise.all([
    loadActiveUnits(actor),
    loadLegalEntityOptions(actor),
    can(actor, "organization.create"),
    can(actor, "organization.edit"),
  ]);
  // Manager and head-count per branch: one small call each for the (at most PAGE_SIZE) visible rows.
  const extras = new Map(
    await Promise.all(
      branches.map(async (branch) => {
        const [managers, people] = await Promise.all([
          forbiddenAsNull(listUnitManagers(actor, branch.id, { limit: 5 })),
          forbiddenAsNull(listEmployees(actor, { limit: 50, orgUnitId: branch.id })),
        ]);
        const primary = managers?.data.find((manager) => manager.isPrimary) ?? managers?.data[0];
        return [branch.id, { manager: primary ? fullNameOf(primary.employee ?? {}) : "", people: people ? `${people.data.length}${people.page.nextCursor ? "+" : ""}` : "—" }] as const;
      }),
    ),
  );
  const parentChoices = unitOptions(allUnits.filter((unit) => unit.type === "CITY" || unit.type === "REGION"), t);

  const addBranch = mayCreate.allowed ? (
    <ActionDialog
      triggerLabel={t("ADMIN.BRANCH_ADD")}
      triggerVariant="primary"
      title={t("ADMIN.BRANCH_ADD")}
      submitLabel={t("COMMON.CREATE")}
      cancelLabel={t("COMMON.CANCEL")}
      closeLabel={t("COMMON.CLOSE")}
      action={createBranchAction}
    >
      <AdminField label={t("ADMIN.ORG_PARENT")} htmlFor="branch-parent" hint={t("ADMIN.BRANCH_PARENT_HINT")} required>
        <Select id="branch-parent" name="parentId" required options={parentChoices} placeholder={t("ADMIN.CHOOSE")} />
      </AdminField>
      <AdminField label={t("ADMIN.BRANCH_LEGAL_ENTITY")} htmlFor="branch-legal-entity">
        <Select id="branch-legal-entity" name="legalEntityId" options={legalEntities} placeholder={t("ADMIN.NONE")} />
      </AdminField>
      <BranchFields t={t} idPrefix="branch-new" />
    </ActionDialog>
  ) : undefined;

  return (
    <AdminPage title={t("ADMIN.BRANCH_TITLE")} intro={t("ADMIN.BRANCH_INTRO")} primaryAction={addBranch} tabs={organizationTabs(t, "branches")}>
      <SearchForm t={t} search={search} />
      <AdminTable<UnitSummary>
        caption={t("ADMIN.BRANCH_TITLE")}
        rows={branches}
        getRowId={(row) => row.id}
        emptyTitle={t("ADMIN.BRANCH_EMPTY_TITLE")}
        emptyDescription={t("ADMIN.BRANCH_EMPTY_DESCRIPTION")}
        emptyAction={addBranch}
        columns={[
          {
            key: "name",
            header: t("ADMIN.ORG_UNIT_NAME"),
            cell: (row) => (
              <a className="font-medium text-brand-700 underline" href={`/admin/organization?unit=${row.id}`}>
                {row.name}
              </a>
            ),
          },
          { key: "address", header: t("ADMIN.BRANCH_ADDRESS"), cell: (row) => addressSummary(row.address) },
          {
            key: "place",
            header: t("ADMIN.BRANCH_STATE_REGION"),
            cell: (row) => {
              const above = ancestorsOf(allUnits, row.id).filter((unit) => unit.type === "STATE" || unit.type === "REGION");
              return above.length === 0 ? "—" : above.map((unit) => unit.name).join(" › ");
            },
          },
          { key: "manager", header: t("ADMIN.ORG_MANAGERS"), cell: (row) => extras.get(row.id)?.manager || t("ADMIN.NONE") },
          { key: "people", header: t("ADMIN.COMPANY_EMPLOYEES"), cell: (row) => extras.get(row.id)?.people ?? "—" },
          { key: "hours", header: t("ADMIN.BRANCH_HOURS"), cell: (row) => hoursSummary(row.operatingHours as Hours, t) },
          { key: "services", header: t("ADMIN.BRANCH_SERVICES"), cell: () => <span className="text-ink-muted">{t("ADMIN.NOT_AVAILABLE")}</span> },
          {
            key: "status",
            header: t("ADMIN.STATUS"),
            cell: (row) => <StatusBadge tone={row.active ? "success" : "neutral"} label={row.active ? t("ADMIN.STATUS_ACTIVE") : t("ADMIN.STATUS_ARCHIVED")} />,
          },
          {
            key: "actions",
            header: t("ADMIN.ACTIONS"),
            srOnlyHeader: true,
            cell: (row) =>
              mayEdit.allowed && row.active ? (
                <ActionDialog
                  triggerLabel={t("COMMON.EDIT")}
                  title={t("ADMIN.BRANCH_EDIT", { name: row.name })}
                  submitLabel={t("COMMON.SAVE")}
                  cancelLabel={t("COMMON.CANCEL")}
                  closeLabel={t("COMMON.CLOSE")}
                  action={updateBranchAction}
                >
                  <input type="hidden" name="unitId" value={row.id} />
                  <BranchFields
                    t={t}
                    idPrefix={`branch-${row.id}`}
                    defaults={{ name: row.name, code: row.code, address: row.address as BranchDefaults["address"], timeZone: row.timeZone, defaultLocale: row.defaultLocale, operatingHours: row.operatingHours as Hours }}
                  />
                </ActionDialog>
              ) : null,
          },
        ]}
      />
      <CursorPager t={t} path={PATH} params={{ search }} cursor={cursor} nextCursor={loaded.data.page.nextCursor} />
      <p className="text-xs text-ink-muted">{t("ADMIN.BRANCH_SERVICES_NOTE")}</p>
    </AdminPage>
  );
}
