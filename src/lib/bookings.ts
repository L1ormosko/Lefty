import { todayUtc } from "./dates";

/**
 * The status to show for a booking.
 *
 * COMPLETED is derived, never stored. An approved booking whose end date has
 * passed is finished - that is a fact about the calendar, not an event anyone
 * needs to record. Storing it would need a scheduled job to flip rows, the
 * hosting plan has none, and a stored status that updates late is worse than
 * one that is always right: a booking would read "approved" for days after it
 * ended.
 *
 * This is the same position already taken for availability (DECISIONS.md):
 * derive from the dates, do not persist a snapshot that can drift.
 *
 * The row itself stays APPROVED, which keeps the GiST exclusion constraint
 * honest - those dates really were occupied, and history should not become
 * bookable again.
 */
export function effectiveBookingStatus(booking: { status: string; endDate: Date | string }): string {
  if (booking.status !== "APPROVED") return booking.status;
  const end = booking.endDate instanceof Date ? booking.endDate : new Date(booking.endDate);
  return end < todayUtc() ? "COMPLETED" : "APPROVED";
}

/** A booking that is still a live commitment: approved and not yet finished. */
export function isLiveBooking(booking: { status: string; endDate: Date | string }): boolean {
  return effectiveBookingStatus(booking) === "APPROVED";
}
