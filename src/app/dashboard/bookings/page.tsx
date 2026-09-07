import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { BookingRow } from "@/components/lists";
import { CancelBookingButton } from "@/components/CancelBookingButton";

export const dynamic = "force-dynamic";

export default async function MyBookings() {
  const user = await requireUser();
  const bookings = await prisma.booking.findMany({
    where: { advertiserId: user.id },
    orderBy: { createdAt: "desc" },
    include: { asset: { select: { id: true, title: true } } },
  });

  return (
    <DashboardShell title={t("dash.myBookings")} nav={advertiserNav()} current="/dashboard/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} action={<LinkButton href="/">{t("nav.explore")}</LinkButton>} />
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking}>
              {(booking.status === "REQUESTED" || booking.status === "APPROVED") && (
                <CancelBookingButton bookingId={booking.id} />
              )}
            </BookingRow>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
