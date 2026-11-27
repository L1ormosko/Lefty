import { KPI_CATALOG, type KpiDefinition } from "@/lib/kpi-catalog";
import type { Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { resolveKpiAccess } from "./access";
import { isKpiComputed } from "./engine";

/** One catalog entry as the API shows it: the spec 13.4 metadata, plus whether the engine computes it yet. */
export type KpiCatalogEntryView = KpiDefinition & { computed: boolean };

/**
 * The catalog entries the viewer may see values of (`GET /api/v1/analytics/kpis`): those whose own permission and field set
 * the viewer holds over some scope. Others are left out rather than listed as forbidden, so a dashboard can render exactly what
 * this returns. Entries share a handful of access profiles; each profile is resolved once.
 */
export async function listVisibleKpis(actor: Actor): Promise<KpiCatalogEntryView[]> {
  const now = new Date();
  return withTenant(actor.tenantId, async (tx) => {
    const allowedByProfile = new Map<string, boolean>();
    const visible: KpiCatalogEntryView[] = [];
    for (const kpi of KPI_CATALOG) {
      const profile = JSON.stringify(kpi.access);
      let allowed = allowedByProfile.get(profile);
      if (allowed === undefined) {
        allowed = (await resolveKpiAccess(tx, actor, kpi, now)).allowed;
        allowedByProfile.set(profile, allowed);
      }
      if (allowed) visible.push({ ...kpi, computed: kpi.status === "ACTIVE" && isKpiComputed(kpi.key) });
    }
    return visible;
  });
}
