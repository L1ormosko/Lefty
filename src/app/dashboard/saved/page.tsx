import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { AssetCard } from "@/components/map/AssetCard";
import { availabilityFor } from "@/lib/availability";
import { redactForRestricted } from "@/server/assets";
import { viewerAccess } from "@/server/subscription";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function SavedAssets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const page = pageFromParam((await searchParams).page);
  // Saving a listing does not buy it. This screen used to hand a lapsed
  // advertiser the address and the price of everything they had bookmarked
  // during their trial - the paywall held on the map and leaked here.
  const viewer = await viewerAccess(user);
  const savedTotal = await prisma.savedAsset.count({ where: { userId: user.id } });
  const saved = await prisma.savedAsset.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    skip: skipFor(page),
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
        <EmptyState title={t("dash.noSaved")} action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>} />
      ) : (
        <>
          {!viewer.full && (
            <p className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-ink-700">
              {t("access.savedRestricted")}
            </p>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            {saved.map(({ asset }) => {
              const card = {
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
              };
              // Exactly the redaction the map applies, from the same function,
              // so the two screens cannot drift apart on what is saleable.
              return <AssetCard key={asset.id} asset={viewer.full ? card : redactForRestricted(card)} />;
            })}
          </div>
          <Pager page={page} total={savedTotal} basePath="/dashboard/saved" />
        </>
      )}
    </DashboardShell>
  );
}
