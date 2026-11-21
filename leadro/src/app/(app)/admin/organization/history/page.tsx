import type { TranslateFn } from "@/lib/i18n";
import { listPlacementHistory } from "@/server/employees";
import { listUnitChanges, type UnitChangeEntry } from "@/server/organization";
import { requireFullSession } from "../../../../_lib/page-context";
import { AccessDenied, AdminPage, Panel } from "../../_components/AdminPage";
import { AdminTable } from "../../_components/AdminTable";
import { CursorPager } from "../../_components/CursorPager";
import { showDateTime, type SearchParams } from "../../_lib/format";
import { loadActiveUnits } from "../../_lib/options";
import { organizationTabs } from "../../_lib/org-tabs";
import { loadForPage, queryParam } from "../../_lib/page-guard";

const PATH = "/admin/organization/history";

/** One sentence describing a structural change, translated (the audit action is a language-neutral id). */
function describeChange(entry: UnitChangeEntry, t: TranslateFn): string {
  const unknown = t("ADMIN.HISTORY_UNKNOWN_UNIT");
  switch (entry.action) {
    case "org_unit.create":
      return t("ADMIN.HISTORY_UNIT_CREATED", { parent: entry.newParentName ?? t("ADMIN.ORG_TOP_LEVEL") });
    case "org_unit.move":
      return t("ADMIN.HISTORY_UNIT_MOVED", { from: entry.previousParentName ?? t("ADMIN.ORG_TOP_LEVEL"), to: entry.newParentName ?? t("ADMIN.ORG_TOP_LEVEL") });
    case "org_unit.archive":
      return t("ADMIN.HISTORY_UNIT_ARCHIVED");
    case "org_unit.manager_assign":
      return t("ADMIN.HISTORY_MANAGER_ASSIGNED");
    case "org_unit.manager_unassign":
      return t("ADMIN.HISTORY_MANAGER_ENDED");
    case "org_unit.update":
      return t("ADMIN.HISTORY_UNIT_EDITED", { fields: entry.changedFields.join(", ") || unknown });
    default:
      return entry.action;
  }
}

/**
 * Organization History (§3.4): structural changes of units and the placement history of people, each
 * with previous and new place, effective dates, who was responsible and why. Read-only.
 */
export default async function OrganizationHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const { actor, t, locale, timeZone } = await requireFullSession();
  const query = await searchParams;
  const unit = queryParam(query, "unit");
  const unitCursor = queryParam(query, "ucursor");
  const placementCursor = queryParam(query, "pcursor");
  const viewer = { locale, timeZone };

  const changes = await loadForPage(() => listUnitChanges(actor, { limit: 25, cursor: unitCursor, orgUnitId: unit }));
  // The two sources need different permissions; a caller may hold only one of them.
  const placements = await loadForPage(() => listPlacementHistory(actor, { limit: 25, cursor: placementCursor, orgUnitId: unit }));
  if (changes.denied && placements.denied) return <AccessDenied t={t} />;

  const units = await loadActiveUnits(actor, { active: "all" });
  const nameOf = (unitId: string | null) => (unitId ? (units.find((candidate) => candidate.id === unitId)?.name ?? t("ADMIN.HISTORY_UNKNOWN_UNIT")) : t("ADMIN.HISTORY_NO_PREVIOUS"));
  const keep = { unit };

  return (
    <AdminPage title={t("ADMIN.HISTORY_TITLE")} intro={t("ADMIN.HISTORY_INTRO")} tabs={organizationTabs(t, "history")}>
      {unit ? (
        <p className="text-sm">
          {t("ADMIN.HISTORY_FILTERED", { unit: nameOf(unit) })}{" "}
          <a className="text-brand-700 underline" href={PATH}>
            {t("ADMIN.HISTORY_CLEAR_FILTER")}
          </a>
        </p>
      ) : null}

      {changes.denied ? null : (
        <Panel title={t("ADMIN.HISTORY_UNIT_CHANGES")}>
          <AdminTable<UnitChangeEntry>
            caption={t("ADMIN.HISTORY_UNIT_CHANGES")}
            rows={changes.data.data}
            getRowId={(row) => row.id}
            emptyTitle={t("ADMIN.HISTORY_EMPTY_TITLE")}
            emptyDescription={t("ADMIN.HISTORY_EMPTY_DESCRIPTION")}
            columns={[
              { key: "when", header: t("ADMIN.HISTORY_WHEN"), cell: (row) => showDateTime(row.occurredAt, viewer) },
              { key: "unit", header: t("ADMIN.HISTORY_UNIT"), cell: (row) => row.orgUnitName ?? t("ADMIN.HISTORY_UNKNOWN_UNIT") },
              { key: "change", header: t("ADMIN.HISTORY_CHANGE"), cell: (row) => describeChange(row, t) },
              { key: "who", header: t("ADMIN.HISTORY_RESPONSIBLE"), cell: (row) => row.recordedBy ?? t("ADMIN.HISTORY_SYSTEM") },
              { key: "reason", header: t("ADMIN.REASON"), cell: (row) => row.reason ?? "—" },
            ]}
          />
          <div className="mt-3">
            <CursorPager t={t} path={PATH} params={{ ...keep, pcursor: placementCursor }} cursor={unitCursor} nextCursor={changes.data.page.nextCursor} cursorParam="ucursor" />
          </div>
        </Panel>
      )}

      {placements.denied ? null : (
        <Panel title={t("ADMIN.HISTORY_PLACEMENTS")}>
          <AdminTable
            caption={t("ADMIN.HISTORY_PLACEMENTS")}
            rows={placements.data.data}
            getRowId={(row) => row.id}
            emptyTitle={t("ADMIN.HISTORY_EMPTY_TITLE")}
            emptyDescription={t("ADMIN.HISTORY_EMPTY_DESCRIPTION")}
            columns={[
              { key: "employee", header: t("ADMIN.ORG_EMPLOYEE"), cell: (row) => <a className="text-brand-700 underline" href={`/admin/employees/${row.employeeId}`}>{row.employeeName}</a> },
              { key: "previous", header: t("ADMIN.HISTORY_PREVIOUS"), cell: (row) => (row.kind === "PRIMARY" ? nameOf(row.previousOrgUnitId) : "—") },
              { key: "new", header: t("ADMIN.HISTORY_NEW"), cell: (row) => `${nameOf(row.orgUnitId)} (${t(`ADMIN.ASSIGNMENT_KIND_SHORT_${row.kind}`)})` },
              { key: "from", header: t("ADMIN.HISTORY_EFFECTIVE"), cell: (row) => `${showDateTime(row.effectiveFrom, viewer)}${row.effectiveTo ? ` → ${showDateTime(row.effectiveTo, viewer)}` : ""}` },
              { key: "who", header: t("ADMIN.HISTORY_RESPONSIBLE"), cell: (row) => row.recordedBy ?? t("ADMIN.HISTORY_SYSTEM") },
              { key: "reason", header: t("ADMIN.REASON"), cell: (row) => row.reason ?? "—" },
            ]}
          />
          <div className="mt-3">
            <CursorPager t={t} path={PATH} params={{ ...keep, ucursor: unitCursor }} cursor={placementCursor} nextCursor={placements.data.page.nextCursor} cursorParam="pcursor" />
          </div>
        </Panel>
      )}
    </AdminPage>
  );
}
