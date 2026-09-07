import Link from "next/link";
import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, Num } from "@/components/ui";
import { AvailabilityBadge, StatusPill, VerificationBadge } from "@/components/badges";
import { CURRENCY } from "@/lib/constants";
import { availabilityFor } from "@/lib/availability";
import { AssetStatusToggle } from "@/components/owner/AssetStatusToggle";

export const dynamic = "force-dynamic";

export default async function OwnerAssets() {
  const user = await requireRole("MEDIA_OWNER");
  const assets = await prisma.mediaAsset.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      periods: { select: { startDate: true, endDate: true } },
      bookings: { where: { status: "APPROVED" }, select: { startDate: true, endDate: true } },
      _count: { select: { inquiries: true, images: true } },
    },
  });

  return (
    <DashboardShell
      title={t("dash.myAssets")}
      nav={ownerNav()}
      current="/owner/assets"
      action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
    >
      {assets.length === 0 ? (
        <EmptyState
          title={t("dash.noAssets")}
          hint={t("dash.noAssetsHint")}
          action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {assets.map((asset) => (
            <Card key={asset.id} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/owner/assets/${asset.id}`} className="font-medium text-ink-900 hover:underline">
                    {asset.title || "—"}
                  </Link>
                  <p className="text-sm text-ink-500 mt-0.5">
                    {asset.city ? `${asset.city} · ${asset.address}` : t("common.notProvided")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <StatusPill
                      label={t(`status.${asset.status}`)}
                      tone={asset.status === "ACTIVE" ? "ok" : "neutral"}
                    />
                    <VerificationBadge status={asset.verificationStatus} size="sm" />
                    {asset.status === "ACTIVE" && (
                      <AvailabilityBadge
                        size="sm"
                        state={availabilityFor({
                          status: asset.status,
                          verificationStatus: asset.verificationStatus,
                          periods: asset.periods,
                          approvedBookings: asset.bookings,
                        })}
                      />
                    )}
                  </div>
                  {asset.reviewNote && asset.verificationStatus === "REJECTED" && (
                    <p className="mt-2 text-sm text-bad-700">{asset.reviewNote}</p>
                  )}
                </div>
                <div className="text-sm text-ink-600 text-end">
                  <p>
                    {asset.priceMonthly != null ? (
                      <Num>{`${CURRENCY}${asset.priceMonthly.toLocaleString("he-IL")} / חודש`}</Num>
                    ) : (
                      t("asset.priceNotPublished")
                    )}
                  </p>
                  <p className="text-xs text-ink-500 mt-1">
                    <Num>{asset._count.inquiries}</Num> {t("dash.requests")} · <Num>{asset._count.images}</Num>{" "}
                    {t("wizard.images")}
                  </p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-ink-100 flex flex-wrap gap-2">
                <LinkButton href={`/owner/assets/${asset.id}`} variant="secondary" size="sm">
                  {t("common.edit")}
                </LinkButton>
                {asset.status !== "DRAFT" && (
                  <>
                    <LinkButton href={`/assets/${asset.id}`} variant="ghost" size="sm">
                      תצוגה ציבורית
                    </LinkButton>
                    <AssetStatusToggle assetId={asset.id} status={asset.status} />
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
