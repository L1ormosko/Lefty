import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { advertiserStage, advertiserTasks } from "@/lib/home-stage";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { Card, EmptyState, LinkButton, StatTile } from "@/components/ui";
import { TaskQueue } from "@/components/home/TaskQueue";
import { FirstSteps } from "@/components/home/FirstSteps";
import { InquiryRow } from "@/components/lists";
import { addDays, todayUtc } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * The buyer's home.
 *
 * Same two zones as the owner's, read as a buyer: what came back, and what is
 * running. The staging rule differs on one point - saving a space is a
 * bookmark, not activity, so a dozen saved spaces and no request sent still
 * means this person is at the beginning.
 */
export default async function AdvertiserOverview() {
  const user = await requireUser();
  const today = todayUtc();

  const [
    totalRequests,
    totalBookings,
    savedCount,
    activeRequests,
    pendingResponses,
    respondedInquiries,
    upcomingBookings,
    approvedBookings,
    savedFreeingSoon,
    recent,
  ] = await Promise.all([
    prisma.inquiry.count({ where: { advertiserId: user.id } }),
    prisma.booking.count({ where: { advertiserId: user.id } }),
    prisma.savedAsset.count({ where: { userId: user.id } }),
    prisma.inquiry.count({ where: { advertiserId: user.id, status: { not: "CLOSED" } } }),
    prisma.inquiry.count({ where: { advertiserId: user.id, status: "PENDING" } }),
    prisma.inquiry.count({ where: { advertiserId: user.id, status: "RESPONDED" } }),
    prisma.booking.count({
      where: { advertiserId: user.id, status: "APPROVED", endDate: { gte: today } },
    }),
    prisma.booking.count({
      where: { advertiserId: user.id, status: "APPROVED", startDate: { gte: today } },
    }),
    /*
     * Spaces this advertiser saved that are about to come free.
     *
     * freeingSoon() already computes this market-wide for /brief, but it was
     * never crossed with what this person actually saved - so the one place
     * the fact is useful, next to their own shortlist, never had it.
     */
    prisma.savedAsset.count({
      where: {
        userId: user.id,
        asset: {
          status: "ACTIVE",
          bookings: {
            some: { status: "APPROVED", endDate: { gte: today, lte: addDays(today, 45) } },
          },
        },
      },
    }),
    prisma.inquiry.findMany({
      where: { advertiserId: user.id },
      orderBy: { createdAt: "desc" },
      take: 3,
      include: {
        asset: {
          select: {
            id: true,
            title: true,
            company: { select: { name: true, contactEmail: true, contactPhone: true } },
          },
        },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    }),
  ]);

  const stage = advertiserStage({
    requests: totalRequests,
    bookings: totalBookings,
    saved: savedCount,
  });
  const tasks = advertiserTasks({ respondedInquiries, approvedBookings, savedFreeingSoon });

  return (
    <DashboardShell
      title={t("adv.homeTitle")}
      nav={advertiserNav({ requests: pendingResponses })}
      current="/dashboard"
      action={<LinkButton href="/brief">{t("nav.brief")}</LinkButton>}
    >
      <p className="text-sm text-ink-600 -mt-2 mb-6">{t("adv.homeLead")}</p>

      {stage === "empty" ? (
        <FirstSteps
          title={t("adv.firstStepsTitle")}
          lead={t("adv.firstStepsLead")}
          steps={[t("adv.step1"), t("adv.step2"), t("adv.step3")]}
          action={<LinkButton href="/brief">{t("brief.submit")}</LinkButton>}
        />
      ) : (
        <>
          <TaskQueue title={t("adv.tasksTitle")} tasks={tasks} />

          {/* At "waiting" the only number that is not zero is what they saved,
              so it is the only one shown. Request and booking counters appear
              once a request exists to count. */}
          <Section title={t("adv.campaignsTitle")}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {stage === "active" && (
                <>
                  <StatTile
                    label={t("dash.activeRequests")}
                    value={activeRequests}
                    href="/dashboard/requests"
                  />
                  <StatTile
                    label={t("dash.pendingResponses")}
                    value={pendingResponses}
                    href="/dashboard/requests"
                  />
                  <StatTile
                    label={t("dash.upcomingBookings")}
                    value={upcomingBookings}
                    href="/dashboard/bookings"
                  />
                </>
              )}
              <StatTile
                label={t("dash.savedAssets")}
                value={savedCount}
                href="/dashboard/saved"
              />
            </div>
          </Section>
        </>
      )}

      {/* Saved something, never asked anyone. Name the gap rather than showing
          request counters that can only read zero. */}
      {stage === "waiting" && (
        <Card className="p-5 mb-6">
          <h2 className="font-semibold text-ink-900">{t("adv.waitingTitle")}</h2>
          <p className="mt-1 text-sm text-ink-600 max-w-xl">{t("adv.waitingLead")}</p>
          <div className="mt-4">
            <LinkButton href="/dashboard/saved" variant="secondary" size="sm">
              {t("dash.savedAssets")}
            </LinkButton>
          </div>
        </Card>
      )}

      {stage === "active" && (
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
      )}
    </DashboardShell>
  );
}
