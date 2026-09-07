import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { EmptyState, LinkButton, StatTile } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { todayUtc } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function AdvertiserOverview() {
  const user = await requireUser();
  const [activeRequests, pendingResponses, upcomingBookings, savedCount, recent] = await Promise.all([
    prisma.inquiry.count({ where: { advertiserId: user.id, status: { not: "CLOSED" } } }),
    prisma.inquiry.count({ where: { advertiserId: user.id, status: "PENDING" } }),
    prisma.booking.count({
      where: { advertiserId: user.id, status: "APPROVED", endDate: { gte: todayUtc() } },
    }),
    prisma.savedAsset.count({ where: { userId: user.id } }),
    prisma.inquiry.findMany({
      where: { advertiserId: user.id },
      orderBy: { createdAt: "desc" },
      take: 3,
      include: { asset: { select: { id: true, title: true } } },
    }),
  ]);

  return (
    <DashboardShell
      title={`${t("dash.overview")} · ${user.name}`}
      nav={advertiserNav({ requests: pendingResponses })}
      current="/dashboard"
      action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatTile label={t("dash.activeRequests")} value={activeRequests} href="/dashboard/requests" />
        <StatTile label={t("dash.pendingResponses")} value={pendingResponses} href="/dashboard/requests" />
        <StatTile label={t("dash.upcomingBookings")} value={upcomingBookings} href="/dashboard/bookings" />
        <StatTile label={t("dash.savedAssets")} value={savedCount} href="/dashboard/saved" />
      </div>

      <Section title={t("dash.myRequests")}>
        {recent.length === 0 ? (
          <EmptyState
            title={t("dash.noRequests")}
            hint={t("dash.noRequestsHint")}
            action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>}
          />
        ) : (
          <div className="space-y-3">
            {recent.map((inquiry) => (
              <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="advertiser" />
            ))}
          </div>
        )}
      </Section>
    </DashboardShell>
  );
}
