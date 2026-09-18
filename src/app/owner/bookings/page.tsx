import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { BookingRow, RowList } from "@/components/lists";
import { BookingDecision } from "@/components/BookingDecision";
import { CancelBookingButton } from "@/components/CancelBookingButton";
import { isLiveBooking } from "@/lib/bookings";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function OwnerBookings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole("MEDIA_OWNER");
  const page = pageFromParam((await searchParams).page);
  const where = { asset: { ownerId: user.id } };
  // The badge counts every request awaiting a decision, not the ones that
  // happen to be on this page.
  const [bookings, total, pending] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: { select: { id: true, title: true } },
        advertiser: { select: { name: true, email: true, phone: true } },
      },
    }),
    prisma.booking.count({ where }),
    prisma.booking.count({ where: { ...where, status: "REQUESTED" } }),
  ]);

  return (
    <DashboardShell title={t("dash.bookings")} nav={ownerNav({ bookings: pending })} current="/owner/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} />
      ) : (
        <>
          <RowList>
            {bookings.map((booking) => (
              <BookingRow key={booking.id} booking={booking} perspective="owner">
                {booking.status === "REQUESTED" && <BookingDecision bookingId={booking.id} />}
                {/* cancelBooking and loadOwnBooking already handled the owner
                    side and notified the advertiser; only this button was
                    missing, so an owner who needed to pull out had no way to. */}
                {isLiveBooking(booking) && <CancelBookingButton bookingId={booking.id} />}
              </BookingRow>
            ))}
          </RowList>
          <Pager page={page} total={total} basePath="/owner/bookings" />
        </>
      )}
    </DashboardShell>
  );
}
