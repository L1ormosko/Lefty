import { requireRole } from "@/server/auth";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { AssetWizard } from "@/components/owner/AssetWizard";

export const dynamic = "force-dynamic";

export default async function NewAsset() {
  await requireRole("MEDIA_OWNER");
  return (
    <DashboardShell title={t("dash.addAsset")} nav={ownerNav()} current="/owner/assets">
      <AssetWizard asset={null} />
    </DashboardShell>
  );
}
