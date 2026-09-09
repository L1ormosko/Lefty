import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { InquiryRow } from "@/components/lists";

export const dynamic = "force-dynamic";

export default async function AdminInquiries() {
  await requireRole("ADMIN");
  const inquiries = await prisma.inquiry.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      asset: { select: { id: true, title: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
      _count: { select: { messages: true } },
    },
  });

  return (
    <DashboardShell title={t("dash.requests")} nav={adminNav()} current="/admin/inquiries">
      {inquiries.length === 0 ? (
        <EmptyState title={t("dash.noRequests")} />
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner" />
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
