import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";
import { ownerNav } from "@/lib/nav";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, Num, StatTile } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { formatDate, todayUtc } from "@/lib/dates";
import Link from "next/link";
import { expiringForOwner } from "@/server/expiring";

export const dynamic = "force-dynamic";

export default async function OwnerOverview() {
  const user = await requireRole("MEDIA_OWNER");
  const scope = { asset: { ownerId: user.id } };

  const [activeAssets, pendingInquiries, confirmedBookings, pendingBookings, pipeline, recent, expiring] =
    await Promise.all([
      prisma.mediaAsset.count({ where: { ownerId: user.id, status: "ACTIVE" } }),
      prisma.inquiry.count({ where: { ...scope, status: "PENDING" } }),
      prisma.booking.count({ where: { ...scope, status: "APPROVED", endDate: { gte: todayUtc() } } }),
      prisma.booking.count({ where: { ...scope, status: "REQUESTED" } }),
      prisma.booking.aggregate({
        _sum: { priceEstimate: true },
        where: { ...scope, status: "REQUESTED" },
      }),
      prisma.inquiry.findMany({
        where: scope,
        orderBy: { createdAt: "desc" },
        take: 3,
        include: {
          asset: { select: { id: true, title: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
        _count: { select: { messages: true } },
        },
      }),
      expiringForOwner(user.id),
    ]);
  const pipelineValue = pipeline._sum.priceEstimate ?? 0;

  return (
    <DashboardShell
      title={`${t("dash.overview")} · ${user.name}`}
      nav={ownerNav({ inquiries: pendingInquiries, bookings: pendingBookings })}
      current="/owner"
      action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-1">
        <StatTile label={t("dash.activeAssets")} value={activeAssets} href="/owner/assets" />
        <StatTile label={t("dash.pendingRequests")} value={pendingInquiries} href="/owner/inquiries" />
        <StatTile label={t("dash.confirmedBookings")} value={confirmedBookings} href="/owner/bookings" />
        <StatTile
          label={t("admin.pipelineValue")}
          value={`${CURRENCY}${pipelineValue.toLocaleString("he-IL")}`}
          href="/owner/bookings"
        />
      </div>
      <p className="text-xs text-ink-500 mb-6">{t("asset.priceEstimateNote")}</p>

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

      {/*
        The renewal pipeline. An owner's most sellable inventory is the space
        that is about to come free, and until now nothing told them - the
        booking calendar held the answer and never surfaced it.
      */}
      <Section title={t("expiring.title")}>
        <p className="-mt-2 mb-3 text-sm text-ink-600">{t("expiring.ownerLead")}</p>
        {expiring.length === 0 ? (
          <EmptyState title={t("expiring.none")} />
        ) : (
          <div className="space-y-2">
            {expiring.map((item) => (
              <Card key={item.bookingId} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Link
                  href={`/assets/${item.assetId}`}
                  className="font-medium text-ink-900 hover:underline"
                >
                  {item.assetTitle}
                </Link>
                <span className="text-sm text-ink-600">{item.city}</span>
                <span className="text-sm text-ink-600">{item.advertiserName}</span>
                <span className="ms-auto text-sm text-ink-700">
                  {t("expiring.endsOn")} <Num>{formatDate(item.endDate)}</Num>
                  <span className="text-ink-500">
                    {" "}
                    (<Num>{item.daysLeft}</Num> {t("expiring.daysLeft")})
                  </span>
                </span>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </DashboardShell>
  );
}
