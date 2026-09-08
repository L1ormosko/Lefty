import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_TAG, cleanup, makeAsset, makeUser, prisma } from "./factories";
import { anonymizeUser, canDeleteAccount, exportUserData } from "@/server/account";
import { queryMapAssets, getPublicAsset } from "@/server/assets";
import { mapQuerySchema } from "@/lib/validation";
import { addDays, todayUtc } from "@/lib/dates";

/**
 * A world with both sides present, because the interesting failures are all
 * about what happens to the *other* party when someone closes their account.
 */
async function world() {
  const owner = await makeUser("MEDIA_OWNER");
  const advertiser = await makeUser("ADVERTISER");
  const asset = await makeAsset(owner.id, { city: "באר שבע" });

  const inquiry = await prisma.inquiry.create({
    data: {
      assetId: asset.id,
      advertiserId: advertiser.id,
      startDate: todayUtc(),
      endDate: addDays(todayUtc(), 10),
      campaignName: `${TEST_TAG} קמפיין החורף של דנה`,
      message: "אפשר לחזור אליי לנייד 050-1234567",
      contactName: "דנה כהן",
      contactEmail: advertiser.email,
      contactPhone: "050-1234567",
    },
  });

  const booking = await prisma.booking.create({
    data: {
      assetId: asset.id,
      advertiserId: advertiser.id,
      inquiryId: inquiry.id,
      startDate: todayUtc(),
      endDate: addDays(todayUtc(), 10),
      status: "REQUESTED",
    },
  });

  await prisma.savedAsset.create({ data: { userId: advertiser.id, assetId: asset.id } });
  await prisma.notification.create({
    data: { userId: advertiser.id, type: "INQUIRY_CREATED", title: "בדיקה" },
  });
  await prisma.session.create({
    data: { userId: advertiser.id, tokenHash: `${TEST_TAG}-${advertiser.id}`, expiresAt: addDays(new Date(), 5) },
  });

  return { owner, advertiser, asset, inquiry, booking };
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("account erasure", () => {
  it("destroys everything that is purely personal", async () => {
    const { advertiser } = await world();
    await anonymizeUser(advertiser.id);

    expect(await prisma.session.count({ where: { userId: advertiser.id } })).toBe(0);
    expect(await prisma.savedAsset.count({ where: { userId: advertiser.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: advertiser.id } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: advertiser.id } })).toBe(0);
  });

  it("overwrites the identity on the user row and locks the account", async () => {
    const { advertiser } = await world();
    await anonymizeUser(advertiser.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: advertiser.id } });
    expect(after.email).not.toBe(advertiser.email);
    expect(after.email).toMatch(/@velto\.invalid$/);
    expect(after.name).not.toBe(advertiser.name);
    expect(after.phone).toBeNull();
    expect(after.isActive).toBe(false);
    expect(after.deletedAt).not.toBeNull();
    // Nobody holds the replacement, so the account cannot be signed into even
    // if some later code path forgets to check isActive.
    expect(after.passwordHash).not.toBe(advertiser.passwordHash);
  });

  it("scrubs the contact details Inquiry keeps its own copy of", async () => {
    // The trap: Inquiry stores contactName/contactEmail/contactPhone, so
    // clearing only the User row would leave the person's details sitting in
    // every inquiry they ever sent - an erasure that erases nothing.
    const { advertiser, inquiry } = await world();
    await anonymizeUser(advertiser.id);

    const after = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.contactName).not.toBe("דנה כהן");
    expect(after.contactEmail).not.toBe(advertiser.email);
    expect(after.contactPhone).toBeNull();
    // Free text the user wrote can name people or carry a phone number.
    expect(after.message).toBeNull();
    expect(after.campaignName).not.toContain("דנה");
  });

  it("keeps the counterparty's commercial records intact", async () => {
    // The second trap: Inquiry and Booking cascade from User, so a hard delete
    // would erase a media owner's booking history because the advertiser left.
    const { advertiser, owner, asset, booking, inquiry } = await world();
    await anonymizeUser(advertiser.id);

    expect(await prisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();
    expect(await prisma.inquiry.findUnique({ where: { id: inquiry.id } })).not.toBeNull();
    // Still visible to the owner as their own record.
    expect(await prisma.booking.count({ where: { asset: { ownerId: owner.id } } })).toBe(1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).not.toBeNull();
  });

  it("takes a departing owner's assets off the map instead of deleting them", async () => {
    const { owner, asset, booking } = await world();
    await anonymizeUser(owner.id);

    const after = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.status).toBe("INACTIVE");
    // Deleting the assets would have cascaded away the advertiser's booking.
    expect(await prisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();

    const onMap = await queryMapAssets(mapQuerySchema.parse({}));
    expect(onMap.some((a) => a.id === asset.id)).toBe(false);
    // And the company contact details stop being served publicly.
    expect(await getPublicAsset(asset.id)).toBeNull();
  });

  it("clears the company contact details when nobody is left in the company", async () => {
    // For a sole trader the "company" email and phone are the person's own,
    // published on every asset page.
    const owner = await makeUser("MEDIA_OWNER");
    const company = await prisma.company.create({
      data: {
        name: `${TEST_TAG} עסק`,
        type: "MEDIA_OWNER",
        contactEmail: owner.email,
        contactPhone: "050-7654321",
        website: "https://example.com",
      },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { companyId: company.id } });

    await anonymizeUser(owner.id);

    const after = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.contactEmail).not.toBe(owner.email);
    expect(after.contactPhone).toBeNull();
    expect(after.website).toBeNull();
  });

  it("leaves a shared company's details alone", async () => {
    // Two people in one company: wiping the contact details because one of
    // them left would be erasing the other person's data.
    const leaving = await makeUser("MEDIA_OWNER");
    const staying = await makeUser("MEDIA_OWNER");
    const company = await prisma.company.create({
      data: { name: `${TEST_TAG} שותפות`, type: "MEDIA_OWNER", contactEmail: "office@example.com" },
    });
    await prisma.user.updateMany({
      where: { id: { in: [leaving.id, staying.id] } },
      data: { companyId: company.id },
    });

    await anonymizeUser(leaving.id);

    const after = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.contactEmail).toBe("office@example.com");
  });

  it("refuses while an approved booking is still running", async () => {
    const { advertiser, owner, booking } = await world();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "APPROVED" } });

    // Blocked for both sides of that booking, not just the one who made it.
    expect((await canDeleteAccount(advertiser.id)).ok).toBe(false);
    expect((await canDeleteAccount(owner.id)).ok).toBe(false);
    await expect(anonymizeUser(advertiser.id)).rejects.toThrow();
  });

  it("allows deletion once the approved booking has ended", async () => {
    const { advertiser, booking } = await world();
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "APPROVED", startDate: addDays(todayUtc(), -30), endDate: addDays(todayUtc(), -10) },
    });

    expect((await canDeleteAccount(advertiser.id)).ok).toBe(true);
    await expect(anonymizeUser(advertiser.id)).resolves.toBeUndefined();
  });

  it("cannot be run twice on the same account", async () => {
    const { advertiser } = await world();
    await anonymizeUser(advertiser.id);
    await expect(anonymizeUser(advertiser.id)).rejects.toThrow();
  });
});

describe("data export", () => {
  it("returns the user's own records", async () => {
    const { advertiser, inquiry } = await world();
    const data = await exportUserData(advertiser.id);

    expect(data.email).toBe(advertiser.email);
    expect(data.inquiries.map((i) => i.id)).toContain(inquiry.id);
    expect(data.bookings).toHaveLength(1);
    expect(data.savedAssets).toHaveLength(1);
  });

  it("never includes credential material", async () => {
    // An export file gets emailed around and left in Downloads. Handing
    // someone their own password hash is a leak, not transparency.
    const { advertiser } = await world();
    const serialised = JSON.stringify(await exportUserData(advertiser.id));

    expect(serialised).not.toContain("passwordHash");
    expect(serialised).not.toContain(advertiser.passwordHash);
    expect(serialised).not.toContain("tokenHash");
  });
});
