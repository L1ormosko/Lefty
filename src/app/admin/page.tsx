import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell, Section } from "@/components/DashboardShell";
import { LinkButton, StatTile } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  await requireRole("ADMIN");
  const [users, assets, pendingVerification, inquiries, bookings, pendingBookings] = await Promise.all([
    prisma.user.count(),
    prisma.mediaAsset.count(),
    prisma.mediaAsset.count({ where: { verificationStatus: "PENDING", status: { not: "DRAFT" } } }),
    prisma.inquiry.count(),
    prisma.booking.count(),
    prisma.booking.count({ where: { status: "REQUESTED" } }),
  ]);

  return (
    <DashboardShell title={t("nav.admin")} nav={adminNav()} current="/admin">
      <Section
        title={t("admin.platform")}
        action={<LinkButton href="/admin/assets" size="sm" variant="secondary">{t("admin.verify")}</LinkButton>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatTile label={t("admin.users")} value={users} href="/admin/users" />
          <StatTile label={t("admin.assets")} value={assets} href="/admin/assets" />
          <StatTile label={t("verify.PENDING")} value={pendingVerification} href="/admin/assets?filter=pending" />
          <StatTile label={t("dash.requests")} value={inquiries} href="/admin/inquiries" />
          <StatTile label={t("dash.bookings")} value={bookings} href="/admin/bookings" />
          <StatTile label={t("booking.REQUESTED")} value={pendingBookings} href="/admin/bookings" />
        </div>
      </Section>
    </DashboardShell>
  );
}
