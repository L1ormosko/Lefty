/**
 * Ownership gates.
 *
 * Rule for the whole codebase: a mutation never calls prisma.<model>.update or
 * .delete with a user-supplied id directly. It goes through one of these
 * loaders first, which throw before any write can happen.
 */
import "server-only";
import { prisma } from "./db";
import { ForbiddenError, NotFoundError } from "./errors";
import type { SessionUser } from "./auth";

export async function loadOwnedAsset(assetId: string, user: SessionUser) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new NotFoundError();
  if (user.role !== "ADMIN" && asset.ownerId !== user.id) throw new ForbiddenError();
  return asset;
}

export async function loadOwnInquiry(inquiryId: string, user: SessionUser) {
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: { asset: { select: { id: true, ownerId: true, title: true } } },
  });
  if (!inquiry) throw new NotFoundError();
  const isAdvertiser = inquiry.advertiserId === user.id;
  const isOwner = inquiry.asset.ownerId === user.id;
  if (user.role !== "ADMIN" && !isAdvertiser && !isOwner) throw new ForbiddenError();
  return { inquiry, isAdvertiser, isOwner };
}

export async function loadOwnBooking(bookingId: string, user: SessionUser) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { asset: { select: { id: true, ownerId: true, title: true } } },
  });
  if (!booking) throw new NotFoundError();
  const isAdvertiser = booking.advertiserId === user.id;
  const isOwner = booking.asset.ownerId === user.id;
  if (user.role !== "ADMIN" && !isAdvertiser && !isOwner) throw new ForbiddenError();
  return { booking, isAdvertiser, isOwner };
}
