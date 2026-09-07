import { notFound } from "next/navigation";
import { requireRole } from "@/server/auth";
import { loadOwnedAsset } from "@/server/authz";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { AssetWizard } from "@/components/owner/AssetWizard";

export const dynamic = "force-dynamic";

export default async function EditAsset({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole("MEDIA_OWNER");
  const { id } = await params;
  await loadOwnedAsset(id, user);

  const asset = await prisma.mediaAsset.findUnique({
    where: { id },
    include: {
      images: { orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }] },
      periods: { orderBy: { startDate: "asc" } },
    },
  });
  if (!asset) notFound();

  return (
    <DashboardShell title={asset.title || t("dash.addAsset")} nav={ownerNav()} current="/owner/assets">
      <AssetWizard asset={asset} />
    </DashboardShell>
  );
}
