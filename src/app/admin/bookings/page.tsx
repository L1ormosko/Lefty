import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState } from "@/components/ui";
import { BookingRow, RowList } from "@/components/lists";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function AdminBookings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole("ADMIN");
  const page = pageFromParam((await searchParams).page);
  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: skipFor(page),
      include: {
        asset: { select: { id: true, title: true } },
        advertiser: { select: { name: true, email: true, phone: true } },
      },
    }),
    prisma.booking.count(),
  ]);

  return (
    <DashboardShell title={t("dash.bookings")} nav={adminNav()} current="/admin/bookings">
      {bookings.length === 0 ? (
        <EmptyState title={t("dash.noBookings")} />
      ) : (
        <>
          <RowList>
            {bookings.map((booking) => (
              <BookingRow key={booking.id} booking={booking} />
            ))}
          </RowList>
          <Pager page={page} total={total} basePath="/admin/bookings" />
        </>
      )}
    </DashboardShell>
  );
}
