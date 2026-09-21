import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, makeUser, prisma } from "./factories";
import { createAccessRequest, openRequestFor, resolveAccessRequest } from "@/server/access-requests";

/**
 * The route from "I am locked out" to "somebody knows".
 *
 * Before this existed, a signed-in customer whose trial had ended read
 * "for renewal - contact us" with nothing to press, while every other control
 * on the screen pointed at /register - which they had already done. These
 * tests pin the two properties that make the replacement worth having: a
 * request reaches an admin, and pressing the button twice is still one order.
 */

let advertiser: { id: string; email: string; role: string };
let admin: { id: string; email: string; role: string };

beforeEach(async () => {
  await cleanup();
  advertiser = await makeUser("ADVERTISER");
  admin = await makeUser("ADMIN");
});

afterAll(async () => {
  await cleanup();
});

describe("asking for access", () => {
  it("records the request and notifies every admin", async () => {
    const secondAdmin = await makeUser("ADMIN");

    const { created } = await createAccessRequest({
      userId: advertiser.id,
      userEmail: advertiser.email,
      message: "מחפשים חמישה שלטים בבאר שבע לינואר",
    });
    expect(created).toBe(true);

    const open = await openRequestFor(advertiser.id);
    expect(open).not.toBeNull();
    expect(open!.message).toContain("באר שבע");

    // Both admins, because there is no concept of an assigned one and a
    // request that only reaches a colleague who is away is a request lost.
    for (const who of [admin.id, secondAdmin.id]) {
      const notifications = await prisma.notification.findMany({
        where: { userId: who, type: "ACCESS_REQUESTED" },
      });
      expect(notifications.length).toBe(1);
      expect(notifications[0].linkUrl).toBe("/admin/access");
    }
  });

  it("returns the existing request rather than opening a second one", async () => {
    await createAccessRequest({ userId: advertiser.id, userEmail: advertiser.email });
    const again = await createAccessRequest({ userId: advertiser.id, userEmail: advertiser.email });

    expect(again.created).toBe(false);
    // A queue full of duplicates is a queue nobody works.
    const all = await prisma.accessRequest.findMany({ where: { userId: advertiser.id } });
    expect(all.length).toBe(1);
  });

  it("lets a resolved request be followed by a new one", async () => {
    const first = await createAccessRequest({ userId: advertiser.id, userEmail: advertiser.email });
    await resolveAccessRequest({
      requestId: first.request.id,
      adminId: admin.id,
      status: "RESOLVED",
    });

    // A customer whose subscription later lapses again has to be able to ask
    // again; the one-open-request rule is about duplicates, not about ever.
    const second = await createAccessRequest({ userId: advertiser.id, userEmail: advertiser.email });
    expect(second.created).toBe(true);
    expect(second.request.id).not.toBe(first.request.id);
  });

  it("stores no message rather than an empty one", async () => {
    const { request } = await createAccessRequest({
      userId: advertiser.id,
      userEmail: advertiser.email,
      message: "   ",
    });
    expect(request.message).toBeNull();
  });
});

describe("closing a request", () => {
  it("tells the customer, whichever way it went", async () => {
    const { request } = await createAccessRequest({
      userId: advertiser.id,
      userEmail: advertiser.email,
    });

    await resolveAccessRequest({
      requestId: request.id,
      adminId: admin.id,
      status: "DISMISSED",
      note: "דיברנו בטלפון",
    });

    // A request that simply vanishes from the customer's side is the failure
    // this whole flow exists to prevent.
    const told = await prisma.notification.findFirst({
      where: { userId: advertiser.id, type: "ACCESS_GRANTED" },
    });
    expect(told).not.toBeNull();
    expect(told!.body).toBe("דיברנו בטלפון");

    expect(await openRequestFor(advertiser.id)).toBeNull();
  });

  it("does not grant anything by itself", async () => {
    const { request } = await createAccessRequest({
      userId: advertiser.id,
      userEmail: advertiser.email,
    });
    await resolveAccessRequest({ requestId: request.id, adminId: admin.id, status: "RESOLVED" });

    // Closing the ticket and opening the paywall are deliberately two acts:
    // the subscription is recorded on /admin/users against an invoice.
    const subscription = await prisma.subscription.findUnique({
      where: { userId: advertiser.id },
    });
    expect(subscription?.paidThrough ?? null).toBeNull();
  });

  it("leaves an already-closed request alone", async () => {
    const { request } = await createAccessRequest({
      userId: advertiser.id,
      userEmail: advertiser.email,
    });
    await resolveAccessRequest({ requestId: request.id, adminId: admin.id, status: "RESOLVED" });
    await resolveAccessRequest({ requestId: request.id, adminId: admin.id, status: "DISMISSED" });

    const row = await prisma.accessRequest.findUnique({ where: { id: request.id } });
    expect(row!.status).toBe("RESOLVED");
  });

  it("is null for a request that does not exist", async () => {
    expect(
      await resolveAccessRequest({ requestId: "nope", adminId: admin.id, status: "RESOLVED" })
    ).toBeNull();
  });
});
