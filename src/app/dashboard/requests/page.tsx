import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { InquiryRow } from "@/components/lists";

export const dynamic = "force-dynamic";

export default async function MyRequests() {
  const user = await requireUser();
  const inquiries = await prisma.inquiry.findMany({
    where: { advertiserId: user.id },
    orderBy: { createdAt: "desc" },
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
  });
  const pending = inquiries.filter((i) => i.status === "PENDING").length;

  return (
    <DashboardShell title={t("dash.myRequests")} nav={advertiserNav({ requests: pending })} current="/dashboard/requests">
      {inquiries.length === 0 ? (
        <EmptyState
          title={t("dash.noRequests")}
          hint={t("dash.noRequestsHint")}
          action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="advertiser">
              <LinkButton href={`/dashboard/requests/${inquiry.id}`} variant="secondary" size="sm">
                {t("inquiry.openThread")}
              </LinkButton>
            </InquiryRow>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
