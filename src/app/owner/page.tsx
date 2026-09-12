import Link from "next/link";
import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";
import { ownerNav } from "@/lib/nav";
import { ownerStage, ownerTasks } from "@/lib/home-stage";
import { listingReadiness } from "@/lib/listing-readiness";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, Num, StatTile } from "@/components/ui";
import { TaskQueue } from "@/components/home/TaskQueue";
import { FirstSteps } from "@/components/home/FirstSteps";
import { InquiryRow } from "@/components/lists";
import { formatDate, todayUtc } from "@/lib/dates";
import { expiringForOwner } from "@/server/expiring";

export const dynamic = "force-dynamic";

/**
 * The seller's home.
 *
 * Two zones, never blended: what is waiting for them, and where their
 * inventory stands. That split is the one pattern common to every supply-side
 * product worth copying. Before anything has happened it shows neither - a
 * checklist instead, because four tiles reading zero tell a new owner the
 * product has nothing for them.
 */
export default async function OwnerOverview() {
  const user = await requireRole("MEDIA_OWNER");
  const scope = { asset: { ownerId: user.id } };
  const today = todayUtc();

  const [
    assets,
    totalInquiries,
    totalBookings,
    activeAssets,
    pendingVerification,
    pendingInquiries,
    confirmedBookings,
    requestedBookings,
    pipeline,
    recent,
    expiring,
    ownAssets,
  ] = await Promise.all([
    prisma.mediaAsset.count({ where: { ownerId: user.id } }),
    prisma.inquiry.count({ where: scope }),
    prisma.booking.count({ where: scope }),
    prisma.mediaAsset.count({ where: { ownerId: user.id, status: "ACTIVE" } }),
    prisma.mediaAsset.count({
      where: { ownerId: user.id, status: "ACTIVE", verificationStatus: "PENDING" },
    }),
    prisma.inquiry.count({ where: { ...scope, status: "PENDING" } }),
    prisma.booking.count({ where: { ...scope, status: "APPROVED", endDate: { gte: today } } }),
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
    // Only the fields the readiness check reads. Availability windows are
    // filtered to future ones here rather than counted whole: a window that
    // ended last year does not make a listing bookable.
    prisma.mediaAsset.findMany({
      where: { ownerId: user.id, status: { not: "DRAFT" } },
      select: {
        id: true,
        priceMonthly: true,
        priceWeekly: true,
        widthCm: true,
        heightCm: true,
        description: true,
        locationTags: true,
        _count: { select: { images: true } },
        periods: { where: { endDate: { gte: today } }, select: { id: true } },
      },
    }),
  ]);

  const incompleteListings = ownAssets.filter(
    (asset) =>
      listingReadiness({
        imageCount: asset._count.images,
        priceMonthly: asset.priceMonthly,
        priceWeekly: asset.priceWeekly,
        futurePeriodCount: asset.periods.length,
        widthCm: asset.widthCm,
        heightCm: asset.heightCm,
        description: asset.description,
        locationTags: asset.locationTags,
      }).level === "incomplete"
  ).length;

  const stage = ownerStage({ assets, inquiries: totalInquiries, bookings: totalBookings });
  const tasks = ownerTasks({
    pendingInquiries,
    requestedBookings,
    incompleteListings,
    contractsEndingSoon: expiring.length,
  });
  const pipelineValue = pipeline._sum.priceEstimate ?? 0;

  return (
    <DashboardShell
      title={t("owner.homeTitle")}
      nav={ownerNav({ inquiries: pendingInquiries, bookings: requestedBookings })}
      current="/owner"
      action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
    >
      <p className="text-sm text-ink-600 -mt-2 mb-6">{t("owner.homeLead")}</p>

      {stage === "empty" ? (
        <FirstSteps
          title={t("owner.firstStepsTitle")}
          lead={t("owner.firstStepsLead")}
          steps={[t("owner.step1"), t("owner.step2"), t("owner.step3")]}
          action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
        />
      ) : (
        <>
          <TaskQueue title={t("owner.tasksTitle")} tasks={tasks} />

          <Section title={t("owner.inventoryTitle")}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatTile label={t("dash.activeAssets")} value={activeAssets} href="/owner/assets" />
              <StatTile
                label={t("verify.PENDING")}
                value={pendingVerification}
                href="/owner/assets"
              />
              {stage === "active" && (
                <>
                  <StatTile
                    label={t("dash.confirmedBookings")}
                    value={confirmedBookings}
                    href="/owner/bookings"
                  />
                  <StatTile
                    label={t("owner.pipelineValue")}
                    value={`${CURRENCY}${pipelineValue.toLocaleString("he-IL")}`}
                    href="/owner/bookings"
                  />
                </>
              )}
            </div>
            {stage === "active" && (
              <p className="text-xs text-ink-500 mt-2">{t("asset.priceEstimateNote")}</p>
            )}
          </Section>
        </>
      )}

      {/* Set up, but nobody has come yet. Say that, rather than showing
          booking counters that can only read zero. */}
      {stage === "waiting" && (
        <Card className="p-5 mb-6">
          <h2 className="font-semibold text-ink-900">{t("owner.waitingTitle")}</h2>
          <p className="mt-1 text-sm text-ink-600 max-w-xl">{t("owner.waitingLead")}</p>
        </Card>
      )}

      {stage === "active" && (
        <Section title={t("dash.requests")}>
          {recent.length === 0 ? (
            <EmptyState title={t("dash.noRequests")} />
          ) : (
            <div className="space-y-3">
              {recent.map((inquiry) => (
                <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner" />
              ))}
            </div>
          )}
        </Section>
      )}

      {/*
        The renewal pipeline. An owner's most sellable inventory is the space
        that is about to come free, and until now nothing told them - the
        booking calendar held the answer and never surfaced it.
      */}
      {expiring.length > 0 && (
        <Section title={t("expiring.title")}>
          <p className="-mt-2 mb-3 text-sm text-ink-600">{t("expiring.ownerLead")}</p>
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
        </Section>
      )}
    </DashboardShell>
  );
}
