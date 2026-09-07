import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { createBookingRequest, decideBooking, hasApprovedOverlap } from "@/server/bookings";
import { addDays, todayUtc } from "@/lib/dates";
import { ConflictError, ValidationError } from "@/server/errors";

let ownerId: string;
let advertiserId: string;

beforeAll(async () => {
  await cleanup();
  ownerId = (await makeUser("MEDIA_OWNER")).id;
  advertiserId = (await makeUser("ADVERTISER")).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** Dates are relative to today so the suite never rots. */
const day = (offset: number) => addDays(todayUtc(), offset);

async function request(assetId: string, startOffset: number, endOffset: number) {
  return createBookingRequest({
    assetId,
    advertiserId,
    startDate: day(startOffset),
    endDate: day(endOffset),
  });
}

describe("booking approval", () => {
  it("rejects an overlapping approval for the same asset", async () => {
    const asset = await makeAsset(ownerId);
    const first = await request(asset.id, 10, 20);
    const second = await request(asset.id, 15, 25);

    await decideBooking({ bookingId: first.id, decision: "APPROVED" });
    await expect(decideBooking({ bookingId: second.id, decision: "APPROVED" })).rejects.toBeInstanceOf(
      ConflictError
    );

    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: second.id } });
    expect(stored.status).toBe("REQUESTED");
  });

  it("allows adjacent ranges that do not share a day", async () => {
    const asset = await makeAsset(ownerId);
    const first = await request(asset.id, 30, 40);
    const second = await request(asset.id, 41, 50);

    await decideBooking({ bookingId: first.id, decision: "APPROVED" });
    const approved = await decideBooking({ bookingId: second.id, decision: "APPROVED" });
    expect(approved.status).toBe("APPROVED");
  });

  it("treats a shared boundary day as a conflict", async () => {
    const asset = await makeAsset(ownerId);
    const first = await request(asset.id, 60, 70);
    const second = await request(asset.id, 70, 80);

    await decideBooking({ bookingId: first.id, decision: "APPROVED" });
    await expect(decideBooking({ bookingId: second.id, decision: "APPROVED" })).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("lets exactly one of two concurrent approvals win", async () => {
    const asset = await makeAsset(ownerId);
    const a = await request(asset.id, 90, 100);
    const b = await request(asset.id, 95, 102);

    const results = await Promise.allSettled([
      decideBooking({ bookingId: a.id, decision: "APPROVED" }),
      decideBooking({ bookingId: b.id, decision: "APPROVED" }),
    ]);
    const approved = results.filter((r) => r.status === "fulfilled");
    expect(approved).toHaveLength(1);

    const stored = await prisma.booking.count({ where: { assetId: asset.id, status: "APPROVED" } });
    expect(stored).toBe(1);
  });

  it("does not count rejected or cancelled bookings as conflicts", async () => {
    const asset = await makeAsset(ownerId);
    const first = await request(asset.id, 120, 130);
    await decideBooking({ bookingId: first.id, decision: "REJECTED" });

    const second = await request(asset.id, 120, 130);
    const approved = await decideBooking({ bookingId: second.id, decision: "APPROVED" });
    expect(approved.status).toBe("APPROVED");
  });

  it("refuses to decide a booking twice", async () => {
    const asset = await makeAsset(ownerId);
    const booking = await request(asset.id, 140, 145);
    await decideBooking({ bookingId: booking.id, decision: "APPROVED" });
    await expect(decideBooking({ bookingId: booking.id, decision: "REJECTED" })).rejects.toBeInstanceOf(
      ConflictError
    );
  });
});

describe("request validation", () => {
  it("refuses a window shorter than the asset minimum", async () => {
    const asset = await makeAsset(ownerId, { minimumBookingDays: 14 });
    await expect(request(asset.id, 160, 162)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses dates in the past", async () => {
    const asset = await makeAsset(ownerId);
    await expect(request(asset.id, -30, -20)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a request against an inactive asset", async () => {
    const asset = await makeAsset(ownerId, { status: "INACTIVE" });
    await expect(request(asset.id, 180, 190)).rejects.toThrow();
  });

  it("hasApprovedOverlap ignores the booking being decided", async () => {
    const asset = await makeAsset(ownerId);
    const booking = await request(asset.id, 200, 210);
    await decideBooking({ bookingId: booking.id, decision: "APPROVED" });
    expect(await hasApprovedOverlap(asset.id, booking.startDate, booking.endDate, booking.id)).toBe(false);
    expect(await hasApprovedOverlap(asset.id, booking.startDate, booking.endDate)).toBe(true);
  });
});
