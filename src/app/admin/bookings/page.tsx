import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { BookingRow } from "@/components/lists";

export const dynamic = "force-dynamic";

export default async function AdminBookings() {
  await requireRole("ADMIN");
  const bookings = await prisma.booking.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      asset: { select: { id: true, title: true } },
      advertiser: { select: { name: true, email: true, phone: true } },
    },
  });

  return (
    <DashboardShell title={t("dash.bookings")} nav={adminNav()} current="/admin/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} />
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking} />
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
