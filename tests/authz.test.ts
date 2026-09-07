import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { loadOwnBooking, loadOwnInquiry, loadOwnedAsset } from "@/server/authz";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { addDays, todayUtc } from "@/lib/dates";
import type { SessionUser } from "@/server/auth";

function session(user: { id: string; email: string; name: string; role: string }): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as SessionUser["role"],
    companyId: null,
    phone: null,
  };
}

let owner: SessionUser;
let otherOwner: SessionUser;
let advertiser: SessionUser;
let otherAdvertiser: SessionUser;
let admin: SessionUser;
let assetId: string;
let inquiryId: string;
let bookingId: string;

beforeAll(async () => {
  await cleanup();
  owner = session(await makeUser("MEDIA_OWNER"));
  otherOwner = session(await makeUser("MEDIA_OWNER"));
  advertiser = session(await makeUser("ADVERTISER"));
  otherAdvertiser = session(await makeUser("ADVERTISER"));
  admin = session(await makeUser("ADMIN"));

  assetId = (await makeAsset(owner.id)).id;
  const inquiry = await prisma.inquiry.create({
    data: {
      assetId,
      advertiserId: advertiser.id,
      startDate: addDays(todayUtc(), 5),
      endDate: addDays(todayUtc(), 20),
      campaignName: "velto-test campaign",
      contactName: "velto-test",
      contactEmail: "contact@velto-test.local",
    },
  });
  inquiryId = inquiry.id;
  bookingId = (
    await prisma.booking.create({
      data: {
        assetId,
        advertiserId: advertiser.id,
        startDate: addDays(todayUtc(), 5),
        endDate: addDays(todayUtc(), 20),
      },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("asset ownership", () => {
  it("lets the owner load their own asset", async () => {
    await expect(loadOwnedAsset(assetId, owner)).resolves.toMatchObject({ id: assetId });
  });

  it("refuses another media owner", async () => {
    await expect(loadOwnedAsset(assetId, otherOwner)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an advertiser", async () => {
    await expect(loadOwnedAsset(assetId, advertiser)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows an admin", async () => {
    await expect(loadOwnedAsset(assetId, admin)).resolves.toMatchObject({ id: assetId });
  });

  it("reports a missing asset as not found, not forbidden", async () => {
    await expect(loadOwnedAsset("does-not-exist", owner)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("inquiry access", () => {
  it("is readable by its advertiser and by the asset owner", async () => {
    await expect(loadOwnInquiry(inquiryId, advertiser)).resolves.toMatchObject({ isAdvertiser: true });
    await expect(loadOwnInquiry(inquiryId, owner)).resolves.toMatchObject({ isOwner: true });
  });

  it("is not readable by an unrelated advertiser", async () => {
    await expect(loadOwnInquiry(inquiryId, otherAdvertiser)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("is not readable by an unrelated media owner", async () => {
    await expect(loadOwnInquiry(inquiryId, otherOwner)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("booking access", () => {
  it("is readable by its advertiser and the asset owner", async () => {
    await expect(loadOwnBooking(bookingId, advertiser)).resolves.toMatchObject({ isAdvertiser: true });
    await expect(loadOwnBooking(bookingId, owner)).resolves.toMatchObject({ isOwner: true });
  });

  it("is not readable by anyone else", async () => {
    await expect(loadOwnBooking(bookingId, otherAdvertiser)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(loadOwnBooking(bookingId, otherOwner)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
