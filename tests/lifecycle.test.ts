import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_TAG, cleanup, makeAsset, makeUser, prisma } from "./factories";
import { cancelBooking } from "@/server/bookings";
import { effectiveBookingStatus, isLiveBooking } from "@/lib/bookings";
import { addDays, todayUtc } from "@/lib/dates";

async function bookingFor(opts: { status?: "REQUESTED" | "APPROVED"; offset?: number } = {}) {
  const owner = await makeUser("MEDIA_OWNER");
  const advertiser = await makeUser("ADVERTISER");
  const asset = await makeAsset(owner.id);
  const offset = opts.offset ?? 0;
  const booking = await prisma.booking.create({
    data: {
      assetId: asset.id,
      advertiserId: advertiser.id,
      startDate: addDays(todayUtc(), offset),
      endDate: addDays(todayUtc(), offset + 7),
      status: opts.status ?? "APPROVED",
    },
  });
  return { owner, advertiser, asset, booking };
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("derived completion", () => {
  it("shows an approved booking whose dates have passed as completed", async () => {
    const past = { status: "APPROVED", endDate: addDays(todayUtc(), -1) };
    expect(effectiveBookingStatus(past)).toBe("COMPLETED");
    expect(isLiveBooking(past)).toBe(false);
  });

  it("leaves a running booking approved, including on its last day", async () => {
    expect(effectiveBookingStatus({ status: "APPROVED", endDate: todayUtc() })).toBe("APPROVED");
    expect(effectiveBookingStatus({ status: "APPROVED", endDate: addDays(todayUtc(), 3) })).toBe("APPROVED");
  });

  it("never rewrites a status that is not APPROVED", async () => {
    // A rejected or cancelled booking in the past is still rejected or
    // cancelled - completion is about approved work actually happening.
    for (const status of ["REQUESTED", "REJECTED", "CANCELLED"]) {
      expect(effectiveBookingStatus({ status, endDate: addDays(todayUtc(), -30) })).toBe(status);
    }
  });

  it("derives without writing: the stored row is untouched", async () => {
    // The row must stay APPROVED so the GiST exclusion constraint keeps
    // treating those dates as taken - history should not become bookable.
    const { booking } = await bookingFor({ offset: -30 });
    expect(effectiveBookingStatus(booking)).toBe("COMPLETED");
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(stored.status).toBe("APPROVED");
  });
});

describe("cancelling a booking", () => {
  it("lets the media owner cancel, and tells the advertiser", async () => {
    // The server always supported this; only the button was missing.
    const { owner, advertiser, booking } = await bookingFor();
    await cancelBooking(booking.id, owner.id);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe("CANCELLED");
    const notified = await prisma.notification.findFirst({
      where: { userId: advertiser.id, type: "BOOKING_CANCELLED" },
    });
    expect(notified).not.toBeNull();
  });

  it("lets the advertiser cancel, and tells the owner", async () => {
    const { owner, advertiser, booking } = await bookingFor();
    await cancelBooking(booking.id, advertiser.id);
    const notified = await prisma.notification.findFirst({
      where: { userId: owner.id, type: "BOOKING_CANCELLED" },
    });
    expect(notified).not.toBeNull();
  });

  it("refuses to cancel a booking that already ran", async () => {
    // Those dates were used. Recording them as "cancelled" would be false.
    const { owner, booking } = await bookingFor({ offset: -30 });
    await expect(cancelBooking(booking.id, owner.id)).rejects.toThrow();
  });

  it("refuses to cancel twice", async () => {
    const { owner, booking } = await bookingFor();
    await cancelBooking(booking.id, owner.id);
    await expect(cancelBooking(booking.id, owner.id)).rejects.toThrow();
  });
});

describe("removing an asset", () => {
  it("hard-deletes a draft nobody has engaged with", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id, { status: "DRAFT" });

    const inquiries = await prisma.inquiry.count({ where: { assetId: asset.id } });
    const bookings = await prisma.booking.count({ where: { assetId: asset.id } });
    expect(inquiries + bookings).toBe(0);

    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
  });

  it("deactivating an engaged asset leaves the advertiser's booking standing", async () => {
    // The trap: MediaAsset cascades to Booking, so deleting a listing would
    // erase bookings that belong to the advertiser as much as to the owner.
    // Deactivation is the equivalent act that does not destroy them.
    const { asset, booking, advertiser } = await bookingFor();
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "INACTIVE" } });

    const survived = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(survived).not.toBeNull();
    expect(await prisma.booking.count({ where: { advertiserId: advertiser.id } })).toBe(1);
  });

  it("proves the cascade is real, so the guard is not theoretical", async () => {
    // If this ever stops holding, the delete path can be relaxed. Until then
    // it is exactly why deleteAssetAction refuses.
    const { asset, booking } = await bookingFor();
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    expect(await prisma.booking.findUnique({ where: { id: booking.id } })).toBeNull();
  });

  it("counts engagement the way the owner page does", async () => {
    const { asset } = await bookingFor();
    const counted = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: asset.id },
      include: { _count: { select: { inquiries: true, bookings: true } } },
    });
    expect(counted._count.bookings).toBeGreaterThan(0);
    expect(counted.title).toContain(TEST_TAG);
  });
});
