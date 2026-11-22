import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as markRead } from "@/app/api/v1/notifications/[id]/read/route";
import { GET as list } from "@/app/api/v1/notifications/route";
import { GET as listPreferences, PUT as setPreference } from "@/app/api/v1/notifications/preferences/route";
import { POST as markAllRead } from "@/app/api/v1/notifications/read-all/route";
import { GET as unreadCount } from "@/app/api/v1/notifications/unread-count/route";
import { withTenant } from "@/server/db";
import { notifyInTx } from "@/server/notifications";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

let w: World;
let tech: string;
let otherTech: string;
let noGrant: string;
let eventCounter = 0;

beforeAll(async () => {
  w = await buildWorld("notify-api");
  tech = await sessionCookie(w.techA1, w.tenantId);
  otherTech = await sessionCookie(w.techB, w.tenantId);
  // A user with no role at all: holds no notifications permission.
  noGrant = await sessionCookie(await createPerson(w.tenantId, "no-grant", { withEmployee: false }), w.tenantId);
});
afterAll(disconnect);

async function notifyUser(userId: string, jobNumber: number, eventType: "job.assigned" | "job.cancelled" = "job.assigned") {
  const { createdNotificationIds } = await withTenant(w.tenantId, (tx) =>
    notifyInTx(tx, { tenantId: w.tenantId, eventType, eventId: `api-${Date.now()}-${eventCounter++}`, recipientUserIds: [userId], params: { jobNumber }, targetId: `job-${jobNumber}` }),
  );
  return createdNotificationIds[0];
}

describe("own notifications API", () => {
  it("lists only the caller's notifications, newest first, with keys and ids but no display text", async () => {
    const first = await notifyUser(w.techA1.userId, 1);
    const second = await notifyUser(w.techA1.userId, 2);
    await notifyUser(w.techB.userId, 3);

    const result = await call(list, "GET", "/api/v1/notifications", { cookie: tech });
    expect(result.status).toBe(200);
    const ids = result.json.data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([second, first]);
    expect(result.json.data[0]).toEqual({
      id: second,
      eventType: "job.assigned",
      templateKey: "NOTIFICATION.JOB_ASSIGNED",
      params: { jobNumber: 2 },
      targetType: "job",
      targetId: "job-2",
      critical: false,
      readAt: null,
      createdAt: expect.any(String),
    });
    expect(result.json.page).toEqual({ nextCursor: null, limit: 50 });
  });

  it("paginates with a cursor and filters unread", async () => {
    const lonely = await createPerson(w.tenantId, "pager", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, lonely, w.roles.TECHNICIAN, [{ type: "OWN" }]);
    const cookie = await sessionCookie(lonely, w.tenantId);
    const created = [await notifyUser(lonely.userId, 10), await notifyUser(lonely.userId, 11), await notifyUser(lonely.userId, 12)];

    const page1 = await call(list, "GET", "/x", { cookie, query: { limit: "2" } });
    expect(page1.json.data).toHaveLength(2);
    expect(page1.json.page.nextCursor).toBeTruthy();
    const page2 = await call(list, "GET", "/x", { cookie, query: { limit: "2", cursor: page1.json.page.nextCursor } });
    expect(page2.json.data).toHaveLength(1);
    expect([...page1.json.data, ...page2.json.data].map((row: { id: string }) => row.id).sort()).toEqual([...created].sort());

    await call(markRead, "POST", "/x", { cookie, params: { id: created[0] } });
    const unread = await call(list, "GET", "/x", { cookie, query: { unread: "true" } });
    expect(unread.json.data).toHaveLength(2);
    expect(unread.json.data.every((row: { readAt: string | null }) => row.readAt === null)).toBe(true);
  });

  it("counts unread and marks read idempotently, keeping the first readAt", async () => {
    const person = await createPerson(w.tenantId, "reader", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, person, w.roles.TECHNICIAN, [{ type: "OWN" }]);
    const cookie = await sessionCookie(person, w.tenantId);
    const [a] = [await notifyUser(person.userId, 20), await notifyUser(person.userId, 21)];
    expect((await call(unreadCount, "GET", "/x", { cookie })).json.data).toEqual({ unread: 2 });

    const read = await call(markRead, "POST", "/x", { cookie, params: { id: a } });
    expect(read.status).toBe(200);
    expect(read.json.data).toMatchObject({ id: a, readAt: expect.any(String) });
    const again = await call(markRead, "POST", "/x", { cookie, params: { id: a } });
    expect(again.json.data.readAt).toBe(read.json.data.readAt);
    expect((await call(unreadCount, "GET", "/x", { cookie })).json.data).toEqual({ unread: 1 });

    const all = await call(markAllRead, "POST", "/x", { cookie });
    expect(all.json.data).toEqual({ updated: 1 });
    expect((await call(unreadCount, "GET", "/x", { cookie })).json.data).toEqual({ unread: 0 });
  });

  it("answers 404 for someone else's notification and a missing one, and never changes the owner's row", async () => {
    const mine = await notifyUser(w.techA1.userId, 30);
    const stolen = await call(markRead, "POST", "/x", { cookie: otherTech, params: { id: mine } });
    expect(stolen.status).toBe(404);
    const missing = await call(markRead, "POST", "/x", { cookie: otherTech, params: { id: "does-not-exist" } });
    expect(missing.status).toBe(404);
    const row = await withTenant(w.tenantId, (tx) => tx.notification.findUniqueOrThrow({ where: { id: mine } }));
    expect(row.readAt).toBeNull();
  });

  it("never shows a notification of another tenant", async () => {
    const other = await buildWorld("notify-api-other");
    const foreign = await withTenant(other.tenantId, (tx) =>
      notifyInTx(tx, { tenantId: other.tenantId, eventType: "job.assigned", eventId: "foreign-1", recipientUserIds: [other.techA1.userId], params: { jobNumber: 99 } }),
    );
    const result = await call(list, "GET", "/x", { cookie: tech });
    expect(result.json.data.map((row: { id: string }) => row.id)).not.toContain(foreign.createdNotificationIds[0]);
    const attempt = await call(markRead, "POST", "/x", { cookie: tech, params: { id: foreign.createdNotificationIds[0] } });
    expect(attempt.status).toBe(404);
  });

  it("requires a session and the notifications permission", async () => {
    expect((await call(list, "GET", "/x")).status).toBe(401);
    expect((await call(list, "GET", "/x", { cookie: noGrant })).status).toBe(403);
    expect((await call(unreadCount, "GET", "/x", { cookie: noGrant })).status).toBe(403);
    expect((await call(markAllRead, "POST", "/x", { cookie: noGrant })).status).toBe(403);
    expect((await call(setPreference, "PUT", "/x", { cookie: noGrant, body: { eventType: "*", channel: "EMAIL", enabled: false } })).status).toBe(403);
  });

  it("rejects malformed query input", async () => {
    expect((await call(list, "GET", "/x", { cookie: tech, query: { limit: "0" } })).status).toBe(400);
    expect((await call(list, "GET", "/x", { cookie: tech, query: { unread: "maybe" } })).status).toBe(400);
  });
});

describe("preferences API", () => {
  it("stores opt-outs for non-critical events and lists them", async () => {
    const put = await call(setPreference, "PUT", "/x", { cookie: otherTech, body: { eventType: "job.assigned", channel: "EMAIL", enabled: false } });
    expect(put.status).toBe(200);
    expect(put.json.data).toEqual({ eventType: "job.assigned", channel: "EMAIL", enabled: false });
    await call(setPreference, "PUT", "/x", { cookie: otherTech, body: { eventType: "job.assigned", channel: "EMAIL", enabled: true } });
    const listed = await call(listPreferences, "GET", "/x", { cookie: otherTech });
    expect(listed.json.data).toEqual([{ eventType: "job.assigned", channel: "EMAIL", enabled: true }]);
  });

  it("refuses to opt out of critical events, of IN_APP, and of unknown events", async () => {
    const critical = await call(setPreference, "PUT", "/x", { cookie: tech, body: { eventType: "job.cancelled", channel: "EMAIL", enabled: false } });
    expect(critical.status).toBe(400);
    expect(critical.json.error.field).toBe("eventType");
    expect((await call(setPreference, "PUT", "/x", { cookie: tech, body: { eventType: "*", channel: "IN_APP", enabled: false } })).status).toBe(400);
    expect((await call(setPreference, "PUT", "/x", { cookie: tech, body: { eventType: "made.up", channel: "SMS", enabled: false } })).status).toBe(400);
  });

  it("keeps one user's preferences invisible to another", async () => {
    await call(setPreference, "PUT", "/x", { cookie: tech, body: { eventType: "*", channel: "SMS", enabled: false } });
    const theirs = await call(listPreferences, "GET", "/x", { cookie: otherTech });
    expect(theirs.json.data.find((row: { channel: string; eventType: string }) => row.eventType === "*" && row.channel === "SMS")).toBeUndefined();
  });
});
