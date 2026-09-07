import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { BookingRow } from "@/components/lists";
import { BookingDecision } from "@/components/BookingDecision";

export const dynamic = "force-dynamic";

export default async function OwnerBookings() {
  const user = await requireRole("MEDIA_OWNER");
  const bookings = await prisma.booking.findMany({
    where: { asset: { ownerId: user.id } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      asset: { select: { id: true, title: true } },
      advertiser: { select: { name: true, email: true } },
    },
  });
  const pending = bookings.filter((b) => b.status === "REQUESTED").length;

  return (
    <DashboardShell title={t("dash.bookings")} nav={ownerNav({ bookings: pending })} current="/owner/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} />
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking}>
              {booking.status === "REQUESTED" && <BookingDecision bookingId={booking.id} />}
            </BookingRow>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
