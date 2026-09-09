import "server-only";

import { prisma } from "./db";
import { notify } from "./notifications";
import { ConflictError } from "./errors";

/**
 * The conversation on an inquiry.
 *
 * It used to be one field: `ownerResponse`. One question, one answer, and
 * nowhere to put the second round that every real negotiation has - the
 * advertiser could not ask a follow-up, and the owner could not correct
 * themselves. Messages now live in their own table.
 *
 * `Inquiry.message` deliberately stays where it is. It is the opening brief,
 * structured alongside the dates, budget and campaign name rather than part of
 * the back-and-forth, and the thread renders it as the first thing said.
 */

export async function loadThread(inquiryId: string) {
  return prisma.inquiryMessage.findMany({
    where: { inquiryId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { id: true, name: true, role: true } } },
  });
}

/**
 * Post a message. Either side may write; who is allowed to reach this inquiry
 * at all is decided by loadOwnInquiry before we get here.
 */
export async function postInquiryMessage(params: {
  inquiryId: string;
  authorId: string;
  body: string;
}) {
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: params.inquiryId },
    include: { asset: { select: { title: true, ownerId: true } } },
  });
  if (!inquiry) throw new ConflictError("הפנייה לא נמצאה.");
  if (inquiry.status === "CLOSED") {
    throw new ConflictError("הפנייה נסגרה ולא ניתן להוסיף לה הודעות.");
  }

  const authorIsOwner = params.authorId === inquiry.asset.ownerId;

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.inquiryMessage.create({
      data: { inquiryId: inquiry.id, authorId: params.authorId, body: params.body },
    });
    // The owner answering is what moves the inquiry forward; the advertiser
    // adding a follow-up does not undo that.
    if (authorIsOwner && inquiry.status === "PENDING") {
      await tx.inquiry.update({
        where: { id: inquiry.id },
        data: { status: "RESPONDED", respondedAt: new Date() },
      });
    }
    return created;
  });

  // Notify the other side, and link to the thread itself rather than to a list
  // the recipient then has to search through.
  const recipientId = authorIsOwner ? inquiry.advertiserId : inquiry.asset.ownerId;
  await notify({
    userId: recipientId,
    type: authorIsOwner ? "INQUIRY_RESPONDED" : "INQUIRY_CREATED",
    title: `הודעה חדשה: ${inquiry.asset.title}`,
    body: params.body.slice(0, 200),
    linkUrl: authorIsOwner
      ? `/dashboard/requests/${inquiry.id}`
      : `/owner/inquiries/${inquiry.id}`,
  });

  return message;
}
