import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, LinkButton } from "@/components/ui";
import { BookingRow } from "@/components/lists";
import { CancelBookingButton } from "@/components/CancelBookingButton";
import { isLiveBooking } from "@/lib/bookings";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function MyBookings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const page = pageFromParam((await searchParams).page);
  const where = { advertiserId: user.id };
  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: {
          select: {
            id: true,
            title: true,
            company: { select: { name: true, contactEmail: true, contactPhone: true } },
          },
        },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  return (
    <DashboardShell title={t("dash.myBookings")} nav={advertiserNav()} current="/dashboard/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} action={<LinkButton href="/explore">{t("nav.explore")}</LinkButton>} />
      ) : (
        <>
          <div className="space-y-3">
            {bookings.map((booking) => (
              <BookingRow key={booking.id} booking={booking}>
                {(booking.status === "REQUESTED" || isLiveBooking(booking)) && (
                  <CancelBookingButton bookingId={booking.id} />
                )}
              </BookingRow>
            ))}
          </div>
          <Pager page={page} total={total} basePath="/dashboard/bookings" />
        </>
      )}
    </DashboardShell>
  );
}
