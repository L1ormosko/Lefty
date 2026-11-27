/**
 * Renders `docs/KPI_DEFINITIONS.md` from the KPI catalog (spec 13.4). The document is GENERATED: edit `src/lib/kpi-catalog.ts` and
 * run `npm run kpi:docs`; `tests/analytics/kpi-definitions-doc.test.ts` fails when the two differ.
 */
import { KPI_CATALOG, KPI_FAMILIES, type KpiDefinition, type KpiFamily } from "./kpi-catalog";

const FAMILY_TITLES: Record<KpiFamily, string> = {
  OPERATIONAL: "Operational (spec 13.2)",
  LEAD: "Lead and recovery (spec 13.1, 9.7)",
  EXECUTIVE: "Executive (spec 13.1)",
  FINANCIAL: "Financial (spec 13.1, 13.3)",
};

const code = (value: string) => `\`${value}\``;

function renderEntry(kpi: KpiDefinition): string[] {
  const access = [
    `any of ${kpi.access.permissions.map(code).join(", ")}`,
    `field set ${code(kpi.access.fieldSet)}`,
    ...(kpi.access.sets.length > 0 ? [`sets ${kpi.access.sets.map(code).join(", ")}`] : []),
    ...(kpi.access.requiresAlso ?? []).map(
      (requirement) => `AND ${code(requirement.permission)} with field set ${code(requirement.fieldSet)} (scopes intersected)`,
    ),
  ].join("; ");
  return [
    `### ${code(kpi.key)}`,
    "",
    `- **Status**: ${kpi.status}${kpi.blockedReason ? ` (${kpi.blockedReason})` : ""}`,
    `- **Definition**: ${kpi.definition}`,
    `- **Formula**: ${kpi.formula}`,
    `- **Unit**: ${kpi.unit}${kpi.estimate ? " (an ESTIMATE, labelled as such)" : ""}${kpi.breakdown ? `, broken down by ${kpi.breakdown}` : ""}`,
    `- **Source records**: ${kpi.sourceRecords.length > 0 ? kpi.sourceRecords.map(code).join(", ") : "none (not defined)"}`,
    `- **Time period**: ${kpi.period.semantics}, anchored on ${kpi.period.anchor}`,
    `- **Organizational scope**: grouped by ${kpi.orgLevels.join(", ")}, inside the viewer's scope`,
    `- **Attribution**: ${kpi.attribution}`,
    `- **Data owner**: ${code(kpi.dataOwnerRole)}`,
    `- **Required access**: ${access}`,
    `- **Label**: ${code(kpi.labelKey)}`,
    "",
  ];
}

/** The full Markdown document for `catalog` (the KPI catalog by default). */
export function renderKpiDefinitions(catalog: readonly KpiDefinition[] = KPI_CATALOG): string {
  const lines = [
    "# KPI definitions",
    "",
    "<!-- GENERATED from src/lib/kpi-catalog.ts by `npm run kpi:docs`. Do not edit by hand. -->",
    "",
    "Every KPI a LEADRO dashboard or report shows (spec 13.4): its formal definition, calculation formula, source records, time",
    "period, applicable organizational scope, responsible data owner (a role; configurable per tenant later), unit and the access it",
    "requires. Dashboards reference KPIs by key; the same key never means two things, a variant has its own key.",
    "",
    "Conventions: periods are tenant-local dates in the tenant's time zone (weeks start Monday). COHORT_IN_PERIOD KPIs measure the",
    "records created in the period as they are now (a cohort's rate can still change later); EVENT_IN_PERIOD KPIs count the anchor",
    "event in the period; SNAPSHOT KPIs are the state at request time. Grouping rolls a record's attributed unit up the current org",
    "tree. Money is integer minor units per currency, never summed across currencies. DURATION is the median in seconds. PER_HOUR",
    "divides numerator records by the hours of a time base. Ledger KPIs count a REVERSAL under the type it reverses.",
    "",
  ];
  for (const family of KPI_FAMILIES) {
    const entries = catalog.filter((kpi) => kpi.family === family);
    if (entries.length === 0) continue;
    lines.push(`## ${FAMILY_TITLES[family]}`, "");
    for (const kpi of entries) lines.push(...renderEntry(kpi));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
