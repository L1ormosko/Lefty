import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/server/db";
import { hashPassword } from "@/server/auth";
import { ConflictError, NotFoundError } from "@/server/errors";
import { todayUtc } from "@/lib/dates";

/**
 * The three rights /privacy promises: to see the data we hold, to correct it,
 * and to have it erased.
 *
 * Erasure here means anonymization, not deletion of rows, and that is a
 * deliberate reading of two facts about the schema rather than a shortcut:
 *
 * 1. Inquiry keeps its own copy of the advertiser's contact details
 *    (contactName / contactEmail / contactPhone). Deleting the User row alone
 *    would have left that personal data behind in every inquiry the person
 *    ever sent - a deletion that deletes nothing.
 * 2. Inquiry and Booking both cascade from User. A booking is a record of two
 *    parties, so a hard delete would erase a media owner's approved bookings
 *    because the advertiser closed their account. For a media owner it is
 *    worse: their MediaAsset rows cascade too, taking every advertiser's
 *    bookings on those assets with them.
 *
 * So: everything that is purely personal is destroyed outright, every
 * identifying field is overwritten wherever it is stored, and the commercial
 * records survive with nobody's name on them. This is what the policy already
 * describes - "deletion or anonymization, subject to the need to retain
 * certain records" - so the document and the code now say the same thing.
 */

const DELETED_NAME = "משתמש שנמחק";
/** Free text the user wrote, which may name people or places. */
const REDACTED = "[הוסר]";

export type AccountExport = Awaited<ReturnType<typeof exportUserData>>;

/**
 * Everything stored about a user, as one object.
 *
 * Never includes passwordHash or any token: handing someone their own
 * credential material is a leak, not transparency, and an export file gets
 * mailed around and left in Downloads.
 */
export async function exportUserData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      role: true,
      isActive: true,
      termsAcceptedAt: true,
      createdAt: true,
      updatedAt: true,
      company: {
        select: {
          name: true,
          type: true,
          businessId: true,
          contactEmail: true,
          contactPhone: true,
          website: true,
        },
      },
      inquiries: {
        select: {
          id: true,
          intent: true,
          startDate: true,
          endDate: true,
          campaignName: true,
          budget: true,
          message: true,
          contactName: true,
          contactEmail: true,
          contactPhone: true,
          status: true,
          createdAt: true,
          messages: { select: { body: true, createdAt: true } },
          asset: { select: { id: true, title: true, city: true } },
        },
      },
      bookings: {
        select: {
          id: true,
          startDate: true,
          endDate: true,
          priceEstimate: true,
          status: true,
          ownerNote: true,
          createdAt: true,
          asset: { select: { id: true, title: true, city: true } },
        },
      },
      assets: {
        select: {
          id: true,
          title: true,
          assetType: true,
          address: true,
          city: true,
          status: true,
          verificationStatus: true,
          createdAt: true,
        },
      },
      savedAssets: {
        select: { createdAt: true, asset: { select: { id: true, title: true } } },
      },
      notifications: {
        select: { type: true, title: true, body: true, readAt: true, createdAt: true },
      },
    },
  });

  if (!user) throw new NotFoundError();

  return {
    exportedAt: new Date().toISOString(),
    note:
      "קובץ זה מכיל את כל המידע שנשמר עליכם ב-VELTO, למעט סיסמתכם (שנשמרת מוצפנת " +
      "ואינה ניתנת לשחזור) ואסימוני התחברות.",
    ...user,
  };
}

/**
 * Whether the account can be closed right now.
 *
 * An approved booking that has not ended yet is a live commercial commitment.
 * Walking away from it mid-flight leaves the other side holding a booked space
 * with no one to contact, so the answer names the count and the last date
 * rather than just refusing.
 */
export async function canDeleteAccount(userId: string): Promise<{ ok: true } | { ok: false; count: number; until: Date }> {
  const today = todayUtc();
  const live = await prisma.booking.findMany({
    where: {
      status: "APPROVED",
      endDate: { gte: today },
      // Both directions: the advertiser who booked, and the owner of the asset.
      OR: [{ advertiserId: userId }, { asset: { ownerId: userId } }],
    },
    select: { endDate: true },
    orderBy: { endDate: "desc" },
  });

  if (live.length === 0) return { ok: true };
  return { ok: false, count: live.length, until: live[0].endDate };
}

/**
 * Erase the person, keep the record.
 *
 * One transaction, so an account is never left half-anonymized: a failure
 * partway through would leave the email cleared but the inquiry copies intact,
 * which is the worst of both outcomes.
 */
export async function anonymizeUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, companyId: true, deletedAt: true },
  });
  if (!user) throw new NotFoundError();
  if (user.deletedAt) throw new ConflictError("החשבון כבר נמחק.");

  // For a one-person business the company's contact fields are the person's
  // own email and phone under another name, so clearing the User row alone
  // would leave them published on every one of their assets. Only when nobody
  // else is left in the company: with other members it is shared business
  // data, and wiping it would be erasing someone else's details.
  const soleMember =
    user.companyId != null &&
    (await prisma.user.count({
      where: { companyId: user.companyId, id: { not: userId }, deletedAt: null },
    })) === 0;

  const check = await canDeleteAccount(userId);
  if (!check.ok) {
    throw new ConflictError(
      `לא ניתן למחוק חשבון עם ${check.count} הזמנות מאושרות שטרם הסתיימו. ` +
        "יש לבטל אותן או להמתין לסיומן."
    );
  }

  // Nobody holds this, and it is not derived from anything: the account can no
  // longer be signed into even if some future code path forgets isActive.
  const unusablePassword = await hashPassword(randomBytes(32).toString("hex"));

  await prisma.$transaction(async (tx) => {
    // Purely personal, no counterparty, no record-keeping interest: destroy.
    await tx.session.deleteMany({ where: { userId } });
    await tx.savedAsset.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });

    // The contact details Inquiry keeps its own copy of. Missing this step is
    // the whole trap - the User row would look erased while every inquiry
    // still carried the person's name, email and phone.
    await tx.inquiry.updateMany({
      where: { advertiserId: userId },
      data: {
        contactName: DELETED_NAME,
        contactEmail: `deleted-${randomUUID()}@velto.invalid`,
        contactPhone: null,
        // Free text the user wrote; it can name a person or a place.
        campaignName: REDACTED,
        message: null,
      },
    });

    // Messages are free text this person wrote, exactly like Inquiry.message
    // above. Adding the thread without adding this line would have quietly
    // reopened the hole the erasure work closed.
    await tx.inquiryMessage.updateMany({
      where: { authorId: userId },
      data: { body: REDACTED },
    });

    // A media owner's assets are not deleted - that would cascade away other
    // people's bookings. Taking them off the map is the equivalent act: an
    // INACTIVE asset is hidden from queryMapAssets and getPublicAsset already
    // refuses to show it (and its company contact details) to the public.
    if (user.role === "MEDIA_OWNER") {
      await tx.mediaAsset.updateMany({
        where: { ownerId: userId, status: { not: "INACTIVE" } },
        data: { status: "INACTIVE" },
      });
    }

    if (soleMember && user.companyId) {
      await tx.company.update({
        where: { id: user.companyId },
        data: {
          contactEmail: `deleted-${randomUUID()}@velto.invalid`,
          contactPhone: null,
          website: null,
          businessId: null,
        },
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        // .invalid is reserved by RFC 2606 precisely for this, so a tombstone
        // address can never collide with a real one someone later registers.
        email: `deleted-${randomUUID()}@velto.invalid`,
        name: DELETED_NAME,
        phone: null,
        passwordHash: unusablePassword,
        isActive: false,
        deletedAt: new Date(),
      },
    });
  });
}
