import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { EmptyState, LinkButton, StatTile } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { todayUtc } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function OwnerOverview() {
  const user = await requireRole("MEDIA_OWNER");
  const scope = { asset: { ownerId: user.id } };

  const [activeAssets, pendingInquiries, confirmedBookings, pendingBookings, recent] = await Promise.all([
    prisma.mediaAsset.count({ where: { ownerId: user.id, status: "ACTIVE" } }),
    prisma.inquiry.count({ where: { ...scope, status: "PENDING" } }),
    prisma.booking.count({ where: { ...scope, status: "APPROVED", endDate: { gte: todayUtc() } } }),
    prisma.booking.count({ where: { ...scope, status: "REQUESTED" } }),
    prisma.inquiry.findMany({
      where: scope,
      orderBy: { createdAt: "desc" },
      take: 3,
      include: { asset: { select: { id: true, title: true } } },
    }),
  ]);

  return (
    <DashboardShell
      title={`${t("dash.overview")} · ${user.name}`}
      nav={ownerNav({ inquiries: pendingInquiries, bookings: pendingBookings })}
      current="/owner"
      action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
    >
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        <StatTile label={t("dash.activeAssets")} value={activeAssets} href="/owner/assets" />
        <StatTile label={t("dash.pendingRequests")} value={pendingInquiries} href="/owner/inquiries" />
        <StatTile label={t("dash.confirmedBookings")} value={confirmedBookings} href="/owner/bookings" />
      </div>

      <Section title={t("dash.requests")}>
        {recent.length === 0 ? (
          <EmptyState
            title={t("dash.noRequests")}
            hint={activeAssets === 0 ? t("dash.noAssetsHint") : undefined}
            action={
              activeAssets === 0 ? (
                <LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {recent.map((inquiry) => (
              <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner" />
            ))}
          </div>
        )}
      </Section>
    </DashboardShell>
  );
}
