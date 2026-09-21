import "server-only";

import { prisma } from "./db";
import { notify } from "./notifications";
import { recordAudit } from "./audit";

/**
 * Asking to be let in.
 *
 * VELTO moves no money: `Subscription.paidThrough` is typed in by an admin
 * against an invoice raised in real bookkeeping software. That was a
 * deliberate decision and it stays - but it left the product able to describe
 * its own paywall and unable to take an order through it. A customer whose
 * trial had ended read "contact us" with nothing to contact.
 *
 * This closes that loop and no more: it records that somebody asked, tells the
 * admins, and gives them a queue. Granting access is still a separate,
 * deliberate act on /admin/users.
 */

/** What a viewer may write alongside the request. */
export const MAX_MESSAGE = 1000;

/** The request this user is currently waiting on, if any. */
export async function openRequestFor(userId: string) {
  return prisma.accessRequest.findFirst({
    where: { userId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, message: true },
  });
}

/**
 * Record a request and tell every admin about it.
 *
 * Returns the existing row rather than creating a second one when the user
 * already has an open request: pressing the button twice is not two orders,
 * and a queue full of duplicates is a queue nobody works.
 */
export async function createAccessRequest(params: {
  userId: string;
  userEmail: string;
  message?: string | null;
}) {
  const existing = await openRequestFor(params.userId);
  if (existing) return { request: existing, created: false };

  const request = await prisma.accessRequest.create({
    data: {
      userId: params.userId,
      message: params.message?.trim().slice(0, MAX_MESSAGE) || null,
    },
    select: { id: true, createdAt: true, message: true },
  });

  // Every admin, because there is no concept of an assigned one. Notification
  // failures are swallowed inside notify() - a request that was recorded has
  // been recorded, and failing the whole action because an email bounced would
  // lose the thing the customer actually asked for.
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  for (const admin of admins) {
    await notify({
      userId: admin.id,
      type: "ACCESS_REQUESTED",
      title: "בקשת גישה חדשה",
      body: params.userEmail,
      linkUrl: "/admin/access",
    });
  }

  await recordAudit({
    actorId: params.userId,
    action: "ACCESS_REQUESTED",
    targetType: "User",
    targetId: params.userId,
    summary: params.userEmail,
  });

  return { request, created: true };
}

/** The admin queue: everything still waiting, oldest first. */
export async function openRequests(limit = 50) {
  return prisma.accessRequest.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      message: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          phone: true,
          company: { select: { name: true } },
          subscription: { select: { trialEndsAt: true, paidThrough: true } },
        },
      },
    },
  });
}

export async function countOpenRequests(): Promise<number> {
  return prisma.accessRequest.count({ where: { status: "OPEN" } });
}

/**
 * Close a request.
 *
 * Deliberately does NOT grant anything. Access is recorded on /admin/users
 * against an invoice, and a button that both closed the ticket and opened the
 * paywall would make it far too easy to give the product away by misclick.
 */
export async function resolveAccessRequest(params: {
  requestId: string;
  adminId: string;
  status: "RESOLVED" | "DISMISSED";
  note?: string | null;
}) {
  const request = await prisma.accessRequest.findUnique({
    where: { id: params.requestId },
    select: { id: true, status: true, userId: true, user: { select: { email: true } } },
  });
  if (!request) return null;
  if (request.status !== "OPEN") return request;

  await prisma.accessRequest.update({
    where: { id: params.requestId },
    data: {
      status: params.status,
      resolvedAt: new Date(),
      resolvedById: params.adminId,
      resolutionNote: params.note?.trim().slice(0, 500) || null,
    },
  });

  // The customer hears back either way. A request that vanishes silently is
  // the thing this whole flow exists to stop happening.
  await notify({
    userId: request.userId,
    type: "ACCESS_GRANTED",
    title: params.status === "RESOLVED" ? "בקשת הגישה שלכם טופלה" : "בקשת הגישה שלכם נסגרה",
    body: params.note?.trim() || undefined,
    linkUrl: "/access",
  });

  await recordAudit({
    actorId: params.adminId,
    action: "ACCESS_REQUEST_RESOLVED",
    targetType: "AccessRequest",
    targetId: params.requestId,
    summary: `${request.user.email} · ${params.status}`,
  });

  return request;
}
