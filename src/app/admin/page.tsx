import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { citiesWithInventory } from "@/server/assets";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";
import { adminNav } from "@/lib/nav";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { Card, LinkButton, Num, StatTile } from "@/components/ui";
import { addDays, todayUtc } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  await requireRole("ADMIN");
  const thirtyDaysAgo = addDays(todayUtc(), -30);

  const [
    users,
    assets,
    verifiedCount,
    pendingVerification,
    rejectedCount,
    inquiries,
    bookings,
    pendingBookings,
    newUsers30,
    newAssets30,
    companiesByType,
    topCities,
    pipeline,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.mediaAsset.count(),
    prisma.mediaAsset.count({ where: { verificationStatus: "VERIFIED" } }),
    prisma.mediaAsset.count({ where: { verificationStatus: "PENDING", status: { not: "DRAFT" } } }),
    prisma.mediaAsset.count({ where: { verificationStatus: "REJECTED" } }),
    prisma.inquiry.count(),
    prisma.booking.count(),
    prisma.booking.count({ where: { status: "REQUESTED" } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.mediaAsset.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.company.groupBy({ by: ["type"], _count: { _all: true } }),
    citiesWithInventory(),
    prisma.booking.aggregate({
      _sum: { priceEstimate: true },
      where: { status: { in: ["REQUESTED", "APPROVED"] } },
    }),
  ]);

  const advertiserCompanies = companiesByType.find((c) => c.type === "ADVERTISER")?._count._all ?? 0;
  const ownerCompanies = companiesByType.find((c) => c.type === "MEDIA_OWNER")?._count._all ?? 0;
  const pipelineValue = pipeline._sum.priceEstimate ?? 0;

  return (
    <DashboardShell title={t("nav.admin")} nav={adminNav()} current="/admin">
      <Section
        title={t("admin.platform")}
        action={<LinkButton href="/admin/assets" size="sm" variant="secondary">{t("admin.verify")}</LinkButton>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatTile label={t("admin.users")} value={users} href="/admin/users" />
          <StatTile label={t("admin.assets")} value={assets} href="/admin/assets" />
          <StatTile label={t("dash.requests")} value={inquiries} href="/admin/inquiries" />
          <StatTile label={t("dash.bookings")} value={bookings} href="/admin/bookings" />
          <StatTile label={t("booking.REQUESTED")} value={pendingBookings} href="/admin/bookings" />
          <StatTile
            label={t("admin.pipelineValue")}
            value={`${CURRENCY}${pipelineValue.toLocaleString("he-IL")}`}
            href="/admin/bookings"
          />
        </div>
        <p className="text-xs text-ink-500 mt-2">{t("asset.priceEstimateNote")}</p>
      </Section>

      <Section title={t("admin.growth")}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label={t("admin.newUsers30")} value={newUsers30} href="/admin/users" />
          <StatTile label={t("admin.newAssets30")} value={newAssets30} href="/admin/assets?filter=all" />
          <StatTile label={t("admin.advertiserCompanies")} value={advertiserCompanies} />
          <StatTile label={t("admin.ownerCompanies")} value={ownerCompanies} />
        </div>
      </Section>

      <Section title={t("admin.verificationFunnel")}>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label={t("verify.VERIFIED")} value={verifiedCount} href="/admin/assets?filter=verified" />
          <StatTile label={t("verify.PENDING")} value={pendingVerification} href="/admin/assets?filter=pending" />
          <StatTile label={t("verify.REJECTED")} value={rejectedCount} href="/admin/assets?filter=rejected" />
        </div>
      </Section>

      <Section title={t("admin.topCities")}>
        {topCities.length === 0 ? (
          <p className="text-sm text-ink-500">{t("common.notProvided")}</p>
        ) : (
          <Card className="p-4">
            <ol className="space-y-2">
              {topCities.slice(0, 5).map((c, i) => (
                <li key={c.city} className="flex items-center gap-3 text-sm">
                  <span className="text-ink-400 w-4">
                    <Num>{i + 1}</Num>
                  </span>
                  <span className="flex-1 text-ink-900">{c.city}</span>
                  <span className="text-ink-500">
                    <Num>{c.count}</Num>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </Section>
    </DashboardShell>
  );
}
