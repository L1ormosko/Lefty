import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { InquiryRow, RowList } from "@/components/lists";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function AdminInquiries({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole("ADMIN");
  const page = pageFromParam((await searchParams).page);
  const [inquiries, total] = await Promise.all([
    prisma.inquiry.findMany({
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: { select: { id: true, title: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.inquiry.count(),
  ]);

  return (
    <DashboardShell title={t("dash.requests")} nav={adminNav()} current="/admin/inquiries">
      {inquiries.length === 0 ? (
        <EmptyState title={t("dash.noRequests")} />
      ) : (
        <>
          <RowList>
            {inquiries.map((inquiry) => (
              <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner" />
            ))}
          </RowList>
          <Pager page={page} total={total} basePath="/admin/inquiries" />
        </>
      )}
    </DashboardShell>
  );
}
