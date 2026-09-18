import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function MyRequests({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const page = pageFromParam((await searchParams).page);
  const where = { advertiserId: user.id };
  // Counted in the database, not from the page. The badge in the navigation
  // means "requests still waiting on an answer"; deriving it from the rows
  // that happen to be on screen would make it shrink as you page forward.
  const [inquiries, total, pending] = await Promise.all([
    prisma.inquiry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: {
          select: {
            id: true,
            title: true,
            city: true,
            company: { select: { name: true, contactEmail: true, contactPhone: true } },
          },
        },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.inquiry.count({ where }),
    prisma.inquiry.count({ where: { ...where, status: "PENDING" } }),
  ]);

  return (
    <DashboardShell title={t("dash.myRequests")} nav={advertiserNav({ requests: pending })} current="/dashboard/requests">
      {inquiries.length === 0 ? (
        <EmptyState
          title={t("dash.noRequests")}
          hint={t("dash.noRequestsHint")}
          action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>}
        />
      ) : (
        <>
          <div className="space-y-3">
            {inquiries.map((inquiry) => (
              <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="advertiser">
                <LinkButton href={`/dashboard/requests/${inquiry.id}`} variant="secondary" size="sm">
                  {t("inquiry.openThread")}
                </LinkButton>
              </InquiryRow>
            ))}
          </div>
          <Pager page={page} total={total} basePath="/dashboard/requests" />
        </>
      )}
    </DashboardShell>
  );
}
