import type { Prisma } from "@prisma/client";
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs, type NotificationParams } from "@/lib/notification-rules";
import { prisma, withTenant } from "@/server/db";
import { logger } from "@/server/logging";
import { redactInaccessible } from "./target-access";
import { getNotificationChannel, type ChannelMessage, type ChannelResult } from "./channels";

export interface DeliverPendingOptions {
  /** Only these notifications (what a service passes after its transaction commits). Omit for the worker sweep. */
  notificationIds?: readonly string[];
  /** Deliveries handled per call (default 100). */
  limit?: number;
  /** Clock override for tests. */
  now?: Date;
}

export interface DeliverySummary {
  attempted: number;
  delivered: number;
  sent: number;
  notConfigured: number;
  failed: number;
  /** Failed attempts that got a retry scheduled. */
  retryScheduled: number;
  /** Failed attempts that have no retries left (or are not retryable). */
  exhausted: number;
}

/** A PENDING row whose `attemptedAt` is older than this is a crashed worker's claim and may be taken again. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LIMIT = 100;

/**
 * Sends the due deliveries of one tenant (§14.3). Run it AFTER the business transaction committed
 * (`deliverAfterCommit`) and from a periodic worker (`deliverPendingForAllTenants`), which also
 * picks up retries.
 *
 * 1. Retries: a FAILED row with `retryStatus = SCHEDULED` whose time has come is claimed (SCHEDULED
 *    becomes NONE, atomically, so two workers cannot both retry it) and the next attempt row is
 *    inserted as PENDING. History is never rewritten: one row per attempt.
 * 2. Each PENDING row is claimed by stamping `attemptedAt` (concurrent workers skip claimed rows),
 *    sent through its `NotificationChannel` OUTSIDE any transaction (no locks held during network
 *    I/O), and the outcome is stored in its own short transaction.
 *
 * An outcome of NOT_CONFIGURED is final and honest: no provider exists, nothing was sent. A thrown
 * channel error is recorded as a retryable failure with a generic reason (provider messages may
 * contain addresses, so they go to the log, not the row).
 */
export async function deliverPending(tenantId: string, options: DeliverPendingOptions = {}): Promise<DeliverySummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const summary: DeliverySummary = { attempted: 0, delivered: 0, sent: 0, notConfigured: 0, failed: 0, retryScheduled: 0, exhausted: 0 };
  const scope: Prisma.NotificationDeliveryWhereInput = options.notificationIds
    ? { notificationId: { in: [...options.notificationIds] } }
    : {};

  await scheduleDueRetries(tenantId, scope, now, limit);

  const claimed = await claimPending(tenantId, scope, now, limit);
  for (const message of claimed) {
    summary.attempted += 1;
    const result = await sendSafely(message, tenantId);
    await recordOutcome(tenantId, message, result, now, summary);
  }
  return summary;
}

/**
 * The call a service makes right after its transaction commits. It never throws: delivery trouble
 * must not turn a committed business change into an error response. Unsent rows stay PENDING and
 * the worker sweep takes them later.
 */
export async function deliverAfterCommit(tenantId: string, notificationIds: readonly string[]): Promise<DeliverySummary | null> {
  if (notificationIds.length === 0) return null;
  try {
    return await deliverPending(tenantId, { notificationIds });
  } catch (error) {
    logger.error("notification delivery failed after commit; rows stay pending for the worker", {
      tenantId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

/** The periodic worker: one sweep over every tenant (or only `tenantIds`). The Tenant table is not tenant-scoped, so listing it is allowed. */
export async function deliverPendingForAllTenants(
  options: Omit<DeliverPendingOptions, "notificationIds"> & { tenantIds?: readonly string[] } = {},
): Promise<number> {
  const { tenantIds, ...deliverOptions } = options;
  const tenants = await prisma.tenant.findMany({ where: tenantIds ? { id: { in: [...tenantIds] } } : {}, select: { id: true } });
  let attempted = 0;
  for (const tenant of tenants) {
    try {
      attempted += (await deliverPending(tenant.id, deliverOptions)).attempted;
    } catch (error) {
      logger.error("notification sweep failed for a tenant", { tenantId: tenant.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return attempted;
}

async function scheduleDueRetries(tenantId: string, scope: Prisma.NotificationDeliveryWhereInput, now: Date, limit: number): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const due = await tx.notificationDelivery.findMany({
      where: { ...scope, status: "FAILED", retryStatus: "SCHEDULED", nextRetryAt: { lte: now } },
      orderBy: { nextRetryAt: "asc" },
      take: limit,
    });
    for (const failed of due) {
      const claim = await tx.notificationDelivery.updateMany({
        where: { id: failed.id, retryStatus: "SCHEDULED" },
        data: { retryStatus: "NONE", nextRetryAt: null },
      });
      if (claim.count === 1) {
        // skipDuplicates: if the next attempt already exists (a half-finished earlier sweep), the claim above
        // still clears this row, and one stuck row can never abort the retries of the whole tenant.
        await tx.notificationDelivery.createMany({
          data: [{ tenantId, notificationId: failed.notificationId, channel: failed.channel, attempt: failed.attempt + 1, status: "PENDING" }],
          skipDuplicates: true,
        });
      }
    }
  });
}

/** What the channel needs, plus the delivery row it belongs to. */
interface ClaimedDelivery extends ChannelMessage {
  deliveryId: string;
  /** The `attemptedAt` stamp this worker wrote; only the holder of this exact claim may record the outcome. */
  claimedAt: Date;
}

async function claimPending(tenantId: string, scope: Prisma.NotificationDeliveryWhereInput, now: Date, limit: number): Promise<ClaimedDelivery[]> {
  return withTenant(tenantId, async (tx) => {
    const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    const candidates = await tx.notificationDelivery.findMany({
      where: { ...scope, status: "PENDING", OR: [{ attemptedAt: null }, { attemptedAt: { lt: staleBefore } }] },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { notification: true },
    });
    const claimed: ClaimedDelivery[] = [];
    for (const row of candidates) {
      const claim = await tx.notificationDelivery.updateMany({
        where: { id: row.id, status: "PENDING", OR: [{ attemptedAt: null }, { attemptedAt: { lt: staleBefore } }] },
        data: { attemptedAt: now },
      });
      if (claim.count !== 1) continue;
      const message: ClaimedDelivery = {
        deliveryId: row.id,
        claimedAt: now,
        tenantId,
        notificationId: row.notificationId,
        recipientId: row.notification.recipientId,
        channel: row.channel,
        attempt: row.attempt,
        eventType: row.notification.eventType,
        templateKey: row.notification.templateKey,
        params: (row.notification.params ?? {}) as NotificationParams,
        targetType: row.notification.targetType,
        targetId: row.notification.targetId,
      };
      // A recipient who lost access to the record since the event must not receive its ids/numbers.
      const [safe] = await redactInaccessible(tx, tenantId, message.recipientId, [message]);
      const { redacted: _redacted, ...deliverable } = safe;
      claimed.push(deliverable);
    }
    return claimed;
  });
}

/** The channel never sees our row id: it is bookkeeping, not part of the message. */
function toChannelMessage({ deliveryId: _deliveryId, claimedAt: _claimedAt, ...message }: ClaimedDelivery): ChannelMessage {
  return message;
}

async function sendSafely(message: ClaimedDelivery, tenantId: string): Promise<ChannelResult> {
  try {
    return await getNotificationChannel(message.channel).send(toChannelMessage(message));
  } catch (error) {
    logger.warn("notification channel threw", { tenantId, channel: message.channel, error: error instanceof Error ? error.name : "unknown" });
    return { outcome: "FAILED", provider: "unknown", reason: "CHANNEL_ERROR", retryable: true };
  }
}

/**
 * Stores the outcome of one attempt, but only if this worker still holds the claim (row still PENDING
 * with our `attemptedAt` stamp). A worker that stalled past the claim timeout and lost its row to a
 * reclaim therefore cannot overwrite the newer attempt. Delivery is AT LEAST ONCE: a crash between the
 * provider call and this write, or a reclaim of a slow attempt, can send twice, so providers must
 * dedupe on `notificationId` + `attempt` (both are in `ChannelMessage`).
 */
async function recordOutcome(tenantId: string, message: ClaimedDelivery, result: ChannelResult, at: Date, summary: DeliverySummary): Promise<void> {
  const base = { attemptedAt: at, nextRetryAt: null, retryStatus: "NONE" as const };
  let data: Prisma.NotificationDeliveryUpdateManyMutationInput;
  let count: () => void;
  switch (result.outcome) {
    case "DELIVERED":
      count = () => (summary.delivered += 1);
      data = { ...base, status: "DELIVERED", deliveredAt: at, provider: result.provider, providerResponse: json(result.providerResponse) };
      break;
    case "SENT":
      count = () => (summary.sent += 1);
      data = { ...base, status: "SENT", provider: result.provider, providerResponse: json(result.providerResponse) };
      break;
    case "NOT_CONFIGURED":
      count = () => (summary.notConfigured += 1);
      data = { ...base, status: "NOT_CONFIGURED" };
      break;
    case "FAILED": {
      const delay = result.retryable ? retryDelayMs(message.attempt) : null;
      count = () => {
        summary.failed += 1;
        if (delay === null) summary.exhausted += 1;
        else summary.retryScheduled += 1;
      };
      data = {
        ...base,
        status: "FAILED",
        provider: result.provider,
        providerResponse: json(result.providerResponse),
        failureReason: result.reason.trim() === "" ? "UNKNOWN" : result.reason.slice(0, 200),
        // EXHAUSTED only means "retries ran out"; a non-retryable failure never had any.
        retryStatus: delay !== null ? "SCHEDULED" : result.retryable && message.attempt >= MAX_DELIVERY_ATTEMPTS ? "EXHAUSTED" : "NONE",
        nextRetryAt: delay !== null ? new Date(at.getTime() + delay) : null,
      };
      break;
    }
  }
  const updated = await withTenant(tenantId, (tx) =>
    tx.notificationDelivery.updateMany({ where: { id: message.deliveryId, status: "PENDING", attemptedAt: message.claimedAt }, data }),
  );
  if (updated.count === 1) count();
  else logger.warn("notification delivery claim was lost; outcome not recorded", { tenantId, deliveryId: message.deliveryId });
}

const json = (value: Record<string, unknown> | undefined): Prisma.InputJsonObject | undefined =>
  value === undefined ? undefined : (value as Prisma.InputJsonObject);
