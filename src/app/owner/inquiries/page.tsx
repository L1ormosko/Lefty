import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { InquiryRow } from "@/components/lists";
import { RespondForm } from "@/components/RespondForm";

export const dynamic = "force-dynamic";

export default async function OwnerInquiries() {
  const user = await requireRole("MEDIA_OWNER");
  const inquiries = await prisma.inquiry.findMany({
    where: { asset: { ownerId: user.id } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { asset: { select: { id: true, title: true } } },
  });
  const pending = inquiries.filter((i) => i.status === "PENDING").length;

  return (
    <DashboardShell
      title={t("dash.requests")}
      nav={ownerNav({ inquiries: pending })}
      current="/owner/inquiries"
    >
      {inquiries.length === 0 ? (
        <EmptyState
          title={t("dash.noRequests")}
          hint={t("dash.noAssetsHint")}
          action={<LinkButton href="/owner/assets/new">{t("dash.addAsset")}</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <InquiryRow key={inquiry.id} inquiry={inquiry} perspective="owner">
              {inquiry.status !== "CLOSED" && <RespondForm inquiryId={inquiry.id} />}
            </InquiryRow>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
