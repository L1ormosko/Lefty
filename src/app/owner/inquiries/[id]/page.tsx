import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { loadOwnInquiry } from "@/server/authz";
import { loadThread } from "@/server/inquiries";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { InquiryThread } from "@/components/inquiry/InquiryThread";

export const dynamic = "force-dynamic";

export default async function OwnerInquiryThread({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  // loadOwnInquiry is the authorization boundary: it throws for anyone who is
  // neither side of this inquiry nor an admin.
  const { isOwner } = await loadOwnInquiry(id, user).catch(() => notFound());
  if (!isOwner && user.role !== "ADMIN") notFound();

  const [inquiry, messages] = await Promise.all([
    prisma.inquiry.findUniqueOrThrow({
      where: { id },
      include: { asset: { select: { id: true, title: true, city: true } } },
    }),
    loadThread(id),
  ]);

  return (
    <DashboardShell title={t("inquiry.thread")} nav={ownerNav()} current="/owner/inquiries">
      <InquiryThread inquiry={inquiry} messages={messages} viewerId={user.id} />
    </DashboardShell>
  );
}
