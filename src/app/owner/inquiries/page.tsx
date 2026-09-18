import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";


export const dynamic = "force-dynamic";

export default async function OwnerInquiries({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole("MEDIA_OWNER");
  const page = pageFromParam((await searchParams).page);
  const where = { asset: { ownerId: user.id } };
  // Counted in the database rather than from the rows on screen: the badge
  // means "waiting on you", which does not change because you turned a page.
  const [inquiries, total, pending] = await Promise.all([
    prisma.inquiry.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: { select: { id: true, title: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.inquiry.count({ where }),
    prisma.inquiry.count({ where: { ...where, status: "PENDING" } }),
  ]);
  // Whether this owner has anything listed at all decides which empty state is
  // honest. Without it the page told an owner with five live billboards to
  // "add your first space", which is both wrong and slightly insulting.
  const assetCount = await prisma.mediaAsset.count({ where: { ownerId: user.id } });

  return (
    <DashboardShell
      title={t("dash.requests")}
      nav={ownerNav({ inquiries: pending })}
      current="/owner/inquiries"
    >
      {inquiries.length === 0 ? (
        <EmptyState
          title={t("dash.noRequests")}
          hint={assetCount === 0 ? t("dash.noAssetsHint") : t("owner.waitingLead")}
          action={
            assetCount === 0 ? (
              <LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>
            ) : (
              <LinkButton href="/owner/assets" variant="secondary">
                {t("dash.myAssets")}
              </LinkButton>
            )
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            {inquiries.map((inquiry) => (
              <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner">
                <LinkButton href={`/owner/inquiries/${inquiry.id}`} variant="secondary" size="sm">
                  {t("inquiry.openThread")}
                </LinkButton>
              </InquiryRow>
            ))}
          </div>
          <Pager page={page} total={total} basePath="/owner/inquiries" />
        </>
      )}
    </DashboardShell>
  );
}
