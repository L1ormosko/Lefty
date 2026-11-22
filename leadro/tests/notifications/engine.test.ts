import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import {
  deliverAfterCommit,
  deliverPending,
  notifyInTx,
  renderNotification,
  renderNotificationForRecipient,
  resetNotificationChannels,
  resolveLeadOperationsRecipients,
  setNotificationChannel,
  type ChannelResult,
  type NotificationChannel,
} from "@/server/notifications";
import { createTranslator } from "@/lib/i18n";
import { createTenant } from "../helpers";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "../authz/fixtures";

let w: World;
beforeAll(async () => {
  w = await buildWorld("notify");
});
afterAll(disconnect);
afterEach(resetNotificationChannels);

const deliveries = (notificationId: string) =>
  withTenant(w.tenantId, (tx) => tx.notificationDelivery.findMany({ where: { notificationId }, orderBy: [{ channel: "asc" }, { attempt: "asc" }] }));
const setChannels = (enabledChannels: Array<"IN_APP" | "PUSH" | "EMAIL" | "SMS">) =>
  withTenant(w.tenantId, (tx) =>
    tx.operationsSettings.upsert({ where: { tenantId: w.tenantId }, create: { tenantId: w.tenantId, enabledChannels }, update: { enabledChannels } }),
  );
let eventCounter = 0;
const nextEventId = () => `evt-${Date.now().toString(36)}-${eventCounter++}`;

/** Notifies in its own committed transaction and returns the created notification ids. */
async function notify(recipients: string[], overrides: Partial<Parameters<typeof notifyInTx>[1]> = {}) {
  return withTenant(w.tenantId, (tx) =>
    notifyInTx(tx, { tenantId: w.tenantId, eventType: "lead.assigned", eventId: nextEventId(), recipientUserIds: recipients, params: { leadNumber: 7 }, ...overrides }),
  );
}

describe("notifyInTx", () => {
  it("writes one notification per recipient with an in-app delivery, storing keys and ids only", async () => {
    const result = await notify([w.techA1.userId, w.techB.userId], { targetId: "lead-1" });
    expect(result.createdNotificationIds).toHaveLength(2);
    const rows = await withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { id: { in: result.createdNotificationIds } } }));
    expect(rows.map((row) => row.recipientId).sort()).toEqual([w.techA1.userId, w.techB.userId].sort());
    expect(rows[0]).toMatchObject({ eventType: "lead.assigned", templateKey: "NOTIFICATION.LEAD_ASSIGNED", params: { leadNumber: 7 }, targetType: "lead", targetId: "lead-1", critical: false, readAt: null });
    const [delivery] = await deliveries(rows[0].id);
    expect(delivery).toMatchObject({ channel: "IN_APP", attempt: 1, status: "PENDING" });
  });

  it("is idempotent per event and recipient, and still notifies new recipients", async () => {
    const eventId = nextEventId();
    const first = await notify([w.techA1.userId], { eventId });
    const again = await notify([w.techA1.userId, w.techB.userId], { eventId });
    expect(first.createdNotificationIds).toHaveLength(1);
    expect(again).toMatchObject({ duplicateCount: 1 });
    expect(again.createdNotificationIds).toHaveLength(1);
    const count = await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { eventId } }));
    expect(count).toBe(2);
    const inAppRows = await withTenant(w.tenantId, (tx) => tx.notificationDelivery.count({ where: { notification: { eventId } } }));
    expect(inAppRows).toBe(2); // the duplicate did not add delivery rows
  });

  it("merges duplicate recipients and skips users that are not active", async () => {
    const inactive = await createPerson(w.tenantId, "inactive", { withEmployee: false });
    await withTenant(w.tenantId, (tx) => tx.user.update({ where: { id: inactive.userId }, data: { status: "DEACTIVATED" } }));
    const result = await notify([w.techA1.userId, w.techA1.userId, inactive.userId, "no-such-user"]);
    expect(result.createdNotificationIds).toHaveLength(1);
    expect(result.skippedRecipientCount).toBe(2);
  });

  it("rejects params that look like PII or free text", async () => {
    await expect(notify([w.techA1.userId], { params: { customerName: "Jane Doe" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(notify([w.techA1.userId], { params: { phone: "+15551234567" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("is rolled back together with the business transaction", async () => {
    const eventId = nextEventId();
    await expect(
      withTenant(w.tenantId, async (tx) => {
        await notifyInTx(tx, { tenantId: w.tenantId, eventType: "job.assigned", eventId, recipientUserIds: [w.techA1.userId], params: { jobNumber: 1 } });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    expect(await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { eventId } }))).toBe(0);
  });

  it("adds a delivery row per enabled channel and records opt-outs as SKIPPED, except for critical events", async () => {
    await setChannels(["IN_APP", "EMAIL", "SMS"]);
    await withTenant(w.tenantId, (tx) =>
      tx.notificationPreference.create({ data: { tenantId: w.tenantId, userId: w.techB.userId, eventType: "*", channel: "EMAIL", enabled: false } }),
    );
    try {
      const normal = await notify([w.techA1.userId, w.techB.userId]);
      const byRecipient = async (userId: string, ids: string[]) => {
        const notification = await withTenant(w.tenantId, (tx) => tx.notification.findFirstOrThrow({ where: { id: { in: ids }, recipientId: userId } }));
        return deliveries(notification.id);
      };
      const optedIn = await byRecipient(w.techA1.userId, normal.createdNotificationIds);
      expect(optedIn.map((row) => [row.channel, row.status])).toEqual([["IN_APP", "PENDING"], ["EMAIL", "PENDING"], ["SMS", "PENDING"]]);
      const optedOut = await byRecipient(w.techB.userId, normal.createdNotificationIds);
      expect(optedOut.find((row) => row.channel === "EMAIL")?.status).toBe("SKIPPED");
      expect(optedOut.find((row) => row.channel === "SMS")?.status).toBe("PENDING");

      const critical = await notify([w.techB.userId], { eventType: "job.cancelled", params: { jobNumber: 3 } });
      const forced = await deliveries(critical.createdNotificationIds[0]);
      expect(forced.find((row) => row.channel === "EMAIL")?.status).toBe("PENDING"); // critical ignores opt-outs
    } finally {
      await setChannels(["IN_APP"]);
      await withTenant(w.tenantId, (tx) => tx.notificationPreference.deleteMany({ where: { userId: w.techB.userId } }));
    }
  });
});

describe("deliverPending", () => {
  it("marks in-app delivered and records NOT_CONFIGURED truthfully for channels without a provider", async () => {
    await setChannels(["IN_APP", "EMAIL", "PUSH", "SMS"]);
    try {
      const { createdNotificationIds } = await notify([w.techA1.userId]);
      const summary = await deliverPending(w.tenantId, { notificationIds: createdNotificationIds });
      expect(summary).toMatchObject({ attempted: 4, delivered: 1, notConfigured: 3, failed: 0 });
      const rows = await deliveries(createdNotificationIds[0]);
      expect(rows.find((row) => row.channel === "IN_APP")).toMatchObject({ status: "DELIVERED", provider: "in_app" });
      for (const channel of ["EMAIL", "PUSH", "SMS"]) {
        const row = rows.find((candidate) => candidate.channel === channel);
        expect(row).toMatchObject({ status: "NOT_CONFIGURED", provider: null, deliveredAt: null, retryStatus: "NONE" });
      }
      // Nothing left to do: a second sweep touches nothing.
      expect(await deliverPending(w.tenantId, { notificationIds: createdNotificationIds })).toMatchObject({ attempted: 0 });
    } finally {
      await setChannels(["IN_APP"]);
    }
  });

  it("records SENT from a real provider implementation", async () => {
    await setChannels(["IN_APP", "EMAIL"]);
    try {
      setNotificationChannel({ channel: "EMAIL", send: async () => ({ outcome: "SENT", provider: "test-mail", providerResponse: { messageId: "m-1" } }) });
      const { createdNotificationIds } = await notify([w.techA1.userId]);
      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds });
      const email = (await deliveries(createdNotificationIds[0])).find((row) => row.channel === "EMAIL");
      expect(email).toMatchObject({ status: "SENT", provider: "test-mail", providerResponse: { messageId: "m-1" } });
    } finally {
      await setChannels(["IN_APP"]);
    }
  });

  it("schedules retries with attempt history, then exhausts, without touching the notification", async () => {
    await setChannels(["IN_APP", "EMAIL"]);
    try {
      let calls = 0;
      const failing: NotificationChannel = {
        channel: "EMAIL",
        send: async (): Promise<ChannelResult> => {
          calls += 1;
          return { outcome: "FAILED", provider: "test-mail", reason: "SMTP_TIMEOUT", retryable: true };
        },
      };
      setNotificationChannel(failing);
      const { createdNotificationIds } = await notify([w.techA1.userId]);
      const id = createdNotificationIds[0];
      const t0 = new Date();

      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds, now: t0 });
      let email = (await deliveries(id)).filter((row) => row.channel === "EMAIL");
      expect(email).toHaveLength(1);
      expect(email[0]).toMatchObject({ attempt: 1, status: "FAILED", failureReason: "SMTP_TIMEOUT", retryStatus: "SCHEDULED" });
      expect(email[0].nextRetryAt!.getTime()).toBe(t0.getTime() + 60_000);

      // Not due yet: nothing happens.
      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds, now: new Date(t0.getTime() + 30_000) });
      expect(calls).toBe(1);

      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds, now: new Date(t0.getTime() + 61_000) });
      email = (await deliveries(id)).filter((row) => row.channel === "EMAIL");
      expect(email.map((row) => [row.attempt, row.status, row.retryStatus])).toEqual([[1, "FAILED", "NONE"], [2, "FAILED", "SCHEDULED"]]);

      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds, now: new Date(t0.getTime() + 61_000 + 301_000) });
      email = (await deliveries(id)).filter((row) => row.channel === "EMAIL");
      expect(email.map((row) => [row.attempt, row.status, row.retryStatus])).toEqual([[1, "FAILED", "NONE"], [2, "FAILED", "NONE"], [3, "FAILED", "EXHAUSTED"]]);
      expect(calls).toBe(3);
      expect(email[2].nextRetryAt).toBeNull();

      // Exhausted: no fourth attempt ever.
      await deliverPending(w.tenantId, { notificationIds: createdNotificationIds, now: new Date(t0.getTime() + 10 * 3_600_000) });
      expect(calls).toBe(3);
      const notification = await withTenant(w.tenantId, (tx) => tx.notification.findUniqueOrThrow({ where: { id } }));
      expect(notification.readAt).toBeNull();
    } finally {
      await setChannels(["IN_APP"]);
    }
  });

  it("does not retry a non-retryable failure, and records a thrown channel error generically", async () => {
    await setChannels(["IN_APP", "EMAIL", "SMS"]);
    try {
      setNotificationChannel({ channel: "EMAIL", send: async () => ({ outcome: "FAILED", provider: "p", reason: "INVALID_ADDRESS", retryable: false }) });
      setNotificationChannel({
        channel: "SMS",
        send: async () => {
          throw new Error("secret detail +15551234567");
        },
      });
      const { createdNotificationIds } = await notify([w.techA1.userId]);
      const summary = await deliverPending(w.tenantId, { notificationIds: createdNotificationIds });
      expect(summary).toMatchObject({ failed: 2, retryScheduled: 1, exhausted: 1, delivered: 1 });
      const rows = await deliveries(createdNotificationIds[0]);
      expect(rows.find((row) => row.channel === "EMAIL")).toMatchObject({ status: "FAILED", retryStatus: "NONE", failureReason: "INVALID_ADDRESS" });
      const sms = rows.find((row) => row.channel === "SMS");
      expect(sms).toMatchObject({ status: "FAILED", retryStatus: "SCHEDULED", failureReason: "CHANNEL_ERROR" });
      expect(JSON.stringify(sms)).not.toContain("5551234567");
    } finally {
      await setChannels(["IN_APP"]);
    }
  });

  it("never throws after commit and never undoes the business change when a channel breaks", async () => {
    await setChannels(["IN_APP", "EMAIL"]);
    try {
      setNotificationChannel({
        channel: "EMAIL",
        send: async () => {
          throw new Error("provider down");
        },
      });
      const eventId = nextEventId();
      const { createdNotificationIds } = await notify([w.techA1.userId], { eventId });
      await expect(deliverAfterCommit(w.tenantId, createdNotificationIds)).resolves.toMatchObject({ failed: 1, delivered: 1 });
      expect(await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { eventId } }))).toBe(1);
      // Even a failure of the delivery machinery itself is swallowed.
      await expect(deliverAfterCommit("", createdNotificationIds)).resolves.toBeNull(); // withTenant refuses an empty tenant id
      await expect(deliverAfterCommit(w.tenantId, [])).resolves.toBeNull();
    } finally {
      await setChannels(["IN_APP"]);
    }
  });

  it("lets two workers share the queue without sending a delivery twice", async () => {
    await setChannels(["IN_APP", "EMAIL"]);
    try {
      let sends = 0;
      setNotificationChannel({
        channel: "EMAIL",
        send: async () => {
          sends += 1;
          return { outcome: "SENT", provider: "p" };
        },
      });
      const { createdNotificationIds } = await notify([w.techA1.userId, w.techB.userId, w.cityManagerA.userId]);
      await Promise.all([
        deliverPending(w.tenantId, { notificationIds: createdNotificationIds }),
        deliverPending(w.tenantId, { notificationIds: createdNotificationIds }),
      ]);
      expect(sends).toBe(3);
    } finally {
      await setChannels(["IN_APP"]);
    }
  });
});

describe("resolveLeadOperationsRecipients", () => {
  it("returns everyone who may assign leads over the unit (descendants included) and nobody outside it", async () => {
    const leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, leadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    const otherCityLeadOps = await createPerson(w.tenantId, "lead-ops-b", { orgUnitId: w.units.cityB });
    await grantTemplate(w.tenantId, otherCityLeadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);

    const recipients = await withTenant(w.tenantId, (tx) => resolveLeadOperationsRecipients(tx, w.tenantId, w.units.teamA1));
    expect(recipients).toContain(leadOps.userId);
    expect(recipients).toContain(w.cityManagerA.userId);
    expect(recipients).toContain(w.stateManager.userId);
    expect(recipients).toContain(w.ceo.userId); // tenant-wide
    expect(recipients).not.toContain(otherCityLeadOps.userId);
    expect(recipients).not.toContain(w.cityManagerB.userId);
    expect(recipients).not.toContain(w.techA1.userId); // technicians cannot assign leads
    expect(recipients).not.toContain(w.dispatcher.userId);

    const withoutActor = await withTenant(w.tenantId, (tx) =>
      resolveLeadOperationsRecipients(tx, w.tenantId, w.units.teamA1, { excludeUserIds: [leadOps.userId] }),
    );
    expect(withoutActor).not.toContain(leadOps.userId);
  });

  it("ignores revoked, expired and disabled holders", async () => {
    const expired = await createPerson(w.tenantId, "expired-ops", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, expired, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }], {
      effectiveFrom: new Date(Date.now() - 2 * 86_400_000),
      effectiveTo: new Date(Date.now() - 86_400_000),
    });
    const disabled = await createPerson(w.tenantId, "disabled-ops", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, disabled, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    await withTenant(w.tenantId, (tx) => tx.user.update({ where: { id: disabled.userId }, data: { status: "DEACTIVATED" } }));
    const recipients = await withTenant(w.tenantId, (tx) => resolveLeadOperationsRecipients(tx, w.tenantId, w.units.cityA));
    expect(recipients).not.toContain(expired.userId);
    expect(recipients).not.toContain(disabled.userId);
  });

  it("widens to leads.view holders only when nobody can assign", async () => {
    const tenant = await createTenant("notify-fallback");
    const unitId = await withTenant(tenant.id, async (tx) => (await tx.orgUnit.create({ data: { tenantId: tenant.id, type: "CITY", name: "Solo" } })).id);
    const viewer = await createPerson(tenant.id, "viewer", { orgUnitId: unitId });
    await grantTemplate(tenant.id, viewer, await makeRole(tenant.id, "Lead viewer", [{ permission: "leads.view" }]), [{ type: "ORG_UNIT", orgUnitId: unitId }]);
    const resolve = () => withTenant(tenant.id, (tx) => resolveLeadOperationsRecipients(tx, tenant.id, unitId));

    expect(await resolve()).toEqual([viewer.userId]); // nobody can assign: fall back to viewers

    const assigner = await createPerson(tenant.id, "assigner", { orgUnitId: unitId });
    await grantTemplate(tenant.id, assigner, await makeRole(tenant.id, "Lead assigner", [{ permission: "leads.assign" }]), [{ type: "ORG_UNIT", orgUnitId: unitId }]);
    expect(await resolve()).toEqual([assigner.userId]); // an assigner exists: viewers are not bothered
  });
});

describe("rendering at read time", () => {
  it("renders title and body from the key and ids in the translator's language", () => {
    const english = createTranslator({ localeChain: ["en-US"] });
    const spanish = createTranslator({ localeChain: ["es-US"] });
    const hebrew = createTranslator({ localeChain: ["he-IL"] });
    const row = { templateKey: "NOTIFICATION.JOB_ASSIGNED", params: { jobNumber: 12 } };
    expect(renderNotification(english, row)).toEqual({ title: "Job assigned to you", body: "Job #12 was assigned to you." });
    expect(renderNotification(spanish, row).body).toContain("12");
    expect(renderNotification(spanish, row).title).not.toBe(renderNotification(english, row).title);
    expect(renderNotification(hebrew, row).body).toContain("12");
  });

  it("uses the RECIPIENT's locale, not the caller's", async () => {
    const spanishUser = await createPerson(w.tenantId, "es-user", { withEmployee: false });
    await withTenant(w.tenantId, (tx) => tx.user.update({ where: { id: spanishUser.userId }, data: { locale: "es-US" } }));
    const row = { templateKey: "NOTIFICATION.JOB_CANCELLED", params: { jobNumber: 5 } };
    const forSpanish = await renderNotificationForRecipient(w.tenantId, spanishUser.userId, row);
    const forDefault = await renderNotificationForRecipient(w.tenantId, w.ceo.userId, row);
    expect(forSpanish.title).toBe("Trabajo cancelado");
    expect(forDefault.title).toBe("Job cancelled");
  });
});
