/**
 * Booking lifecycle.
 *
 * The double-booking guarantee lives in the database: a partial GiST exclusion
 * constraint forbids two APPROVED bookings whose date ranges overlap on the
 * same asset (see prisma/migrations/*_init/migration.sql). The check below is
 * for a friendly error message; the constraint is what makes it true under
 * concurrency.
 */
import "server-only";
import { Prisma, type BookingStatus } from "@prisma/client";
import { prisma } from "./db";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { notify } from "./notifications";
import { daysBetween, toUtcDate, todayUtc } from "@/lib/dates";
import { estimatePrice } from "@/lib/availability";
import { t } from "@/lib/labels";

const OVERLAP_CONSTRAINT = "Booking_no_overlapping_approved";

/**
 * Postgres raises SQLSTATE 23P01 for the exclusion constraint. Prisma surfaces
 * that as PrismaClientUnknownRequestError with the constraint name in the
 * message today, but the mapping is a Prisma implementation detail: match on
 * the constraint name anywhere in the error rather than on an error class or
 * code, so a Prisma upgrade cannot silently turn a conflict into a 500.
 */
export function isOverlapViolation(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (JSON.stringify(err.meta ?? {}).includes(OVERLAP_CONSTRAINT)) return true;
  }
  return err instanceof Error && err.message.includes(OVERLAP_CONSTRAINT);
}

export async function hasApprovedOverlap(
  assetId: string,
  startDate: Date,
  endDate: Date,
  excludeBookingId?: string
): Promise<boolean> {
  const conflict = await prisma.booking.findFirst({
    where: {
      assetId,
      status: "APPROVED",
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true },
  });
  return conflict != null;
}

/** Validate a requested window against the asset's own rules. */
export async function validateRequestWindow(assetId: string, startDate: Date, endDate: Date) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, status: true, minimumBookingDays: true, priceWeekly: true, priceMonthly: true },
  });
  if (!asset || asset.status !== "ACTIVE") throw new NotFoundError();
  if (startDate > endDate) throw new ValidationError(t("request.dateOrderError"));
  if (startDate < todayUtc()) throw new ValidationError(t("request.pastDateError"));
  const days = daysBetween(startDate, endDate);
  if (days < asset.minimumBookingDays) throw new ValidationError(t("request.minDaysError"));
  return { asset, days };
}

export async function createBookingRequest(params: {
  assetId: string;
  advertiserId: string;
  inquiryId?: string;
  startDate: Date;
  endDate: Date;
}) {
  const { asset, days } = await validateRequestWindow(params.assetId, params.startDate, params.endDate);
  const priceEstimate = estimatePrice(asset, days);

  const booking = await prisma.booking.create({
    data: {
      assetId: params.assetId,
      advertiserId: params.advertiserId,
      inquiryId: params.inquiryId,
      startDate: params.startDate,
      endDate: params.endDate,
      priceEstimate,
      status: "REQUESTED",
    },
    include: { asset: { select: { title: true, ownerId: true } } },
  });

  await notify({
    userId: booking.asset.ownerId,
    type: "BOOKING_REQUESTED",
    title: `בקשת הזמנה חדשה: ${booking.asset.title}`,
    body: `בקשה לתאריכים ${params.startDate.toISOString().slice(0, 10)} עד ${params.endDate
      .toISOString()
      .slice(0, 10)}`,
    linkUrl: "/owner/bookings",
  });

  return booking;
}

/**
 * Owner (or admin) decides on a booking request.
 * Approval is the only place a booking becomes binding, so it is the only
 * place the overlap rule is enforced.
 */
export async function decideBooking(params: {
  bookingId: string;
  decision: Extract<BookingStatus, "APPROVED" | "REJECTED">;
  ownerNote?: string;
}) {
  const existing = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    include: { asset: { select: { id: true, title: true } } },
  });
  if (!existing) throw new NotFoundError();
  if (existing.status !== "REQUESTED") {
    throw new ConflictError("הבקשה כבר טופלה.");
  }

  if (params.decision === "APPROVED") {
    const clash = await hasApprovedOverlap(
      existing.assetId,
      existing.startDate,
      existing.endDate,
      existing.id
    );
    if (clash) throw new ConflictError(t("dash.conflict"));
  }

  let updated;
  try {
    updated = await prisma.booking.update({
      where: { id: params.bookingId },
      data: {
        status: params.decision,
        ownerNote: params.ownerNote || null,
        decidedAt: new Date(),
      },
    });
  } catch (err) {
    // Lost the race against a concurrent approval: the database refused it.
    if (isOverlapViolation(err)) throw new ConflictError(t("dash.conflict"));
    throw err;
  }

  await notify({
    userId: existing.advertiserId,
    type: params.decision === "APPROVED" ? "BOOKING_APPROVED" : "BOOKING_REJECTED",
    title:
      params.decision === "APPROVED"
        ? `ההזמנה אושרה: ${existing.asset.title}`
        : `ההזמנה נדחתה: ${existing.asset.title}`,
    body: params.ownerNote || undefined,
    linkUrl: "/dashboard/bookings",
  });

  return updated;
}

export async function cancelBooking(bookingId: string, byUserId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { asset: { select: { ownerId: true, title: true } } },
  });
  if (!booking) throw new NotFoundError();
  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    throw new ConflictError("לא ניתן לבטל הזמנה זו.");
  }
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED", decidedAt: new Date() },
  });
  const notifyUserId =
    byUserId === booking.advertiserId ? booking.asset.ownerId : booking.advertiserId;
  await notify({
    userId: notifyUserId,
    type: "BOOKING_CANCELLED",
    title: `הזמנה בוטלה: ${booking.asset.title}`,
    linkUrl: byUserId === booking.advertiserId ? "/owner/bookings" : "/dashboard/bookings",
  });
  return updated;
}
