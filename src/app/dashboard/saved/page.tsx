import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { AssetCard } from "@/components/map/AssetCard";
import { availabilityFor } from "@/lib/availability";

export const dynamic = "force-dynamic";

export default async function SavedAssets() {
  const user = await requireUser();
  const saved = await prisma.savedAsset.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: {
      asset: {
        include: {
          images: { where: { isPrimary: true }, take: 1 },
          periods: { select: { startDate: true, endDate: true } },
          bookings: { where: { status: "APPROVED" }, select: { startDate: true, endDate: true } },
        },
      },
    },
  });

  return (
    <DashboardShell title={t("dash.savedAssets")} nav={advertiserNav()} current="/dashboard/saved">
      {saved.length === 0 ? (
        <EmptyState title={t("dash.noSaved")} action={<LinkButton href="/">{t("nav.explore")}</LinkButton>} />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {saved.map(({ asset }) => (
            <AssetCard
              key={asset.id}
              asset={{
                id: asset.id,
                title: asset.title,
                city: asset.city,
                address: asset.address,
                assetType: asset.assetType,
                isDigital: asset.isDigital,
                latitude: asset.latitude,
                longitude: asset.longitude,
                priceMonthly: asset.priceMonthly,
                priceWeekly: asset.priceWeekly,
                verificationStatus: asset.verificationStatus,
                isDemo: asset.isDemo,
                imageUrl: asset.images[0]?.url ?? null,
                availability: availabilityFor({
                  status: asset.status,
                  verificationStatus: asset.verificationStatus,
                  periods: asset.periods,
                  approvedBookings: asset.bookings,
                }),
                nextAvailable: null,
              }}
            />
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
