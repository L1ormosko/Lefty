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
    include: { asset: { select: { id: true, title: true, city: true } } },
  });
  const pending = inquiries.filter((i) => i.status === "PENDING").length;

  return (
    <DashboardShell title={t("dash.myRequests")} nav={advertiserNav({ requests: pending })} current="/dashboard/requests">
      {inquiries.length === 0 ? (
        <EmptyState
          title={t("dash.noRequests")}
          hint={t("dash.noRequestsHint")}
          action={<LinkButton href="/">{t("nav.explore")}</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="advertiser" />
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
