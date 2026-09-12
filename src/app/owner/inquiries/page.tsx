import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { InquiryRow } from "@/components/lists";


export const dynamic = "force-dynamic";

export default async function OwnerInquiries() {
  const user = await requireRole("MEDIA_OWNER");
  const inquiries = await prisma.inquiry.findMany({
    where: { asset: { ownerId: user.id } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      asset: { select: { id: true, title: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
      _count: { select: { messages: true } },
    },
  });
  const pending = inquiries.filter((i) => i.status === "PENDING").length;
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
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner">
              <LinkButton href={`/owner/inquiries/${inquiry.id}`} variant="secondary" size="sm">
                {t("inquiry.openThread")}
              </LinkButton>
            </InquiryRow>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
