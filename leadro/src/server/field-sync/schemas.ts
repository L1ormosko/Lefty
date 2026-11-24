import { z } from "zod";

/** Zod schemas of the batch sync endpoint (§8.7). Only the SHAPE of the batch is checked here; each handler validates its own payload. */

/** Most events one request may carry: a device that was offline for a day sends several batches, not one huge one. */
export const MAX_SYNC_BATCH_EVENTS = 100;

const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const syncEventSchema = z
  .object({
    /** Lower-cased so one UUID written in two cases is one event (the idempotency key compares strings). */
    clientEventId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    /** Dotted lower-case key of the event kind, e.g. `job.note`. Unknown kinds are reported per event, not as a 400. */
    type: z.string().trim().min(3).max(60).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "A dotted lower-case key like job.note"),
    /** When it happened on the device. Events are applied in this order. */
    occurredAt: instant,
    jobId: z.string().trim().min(1).max(64).optional(),
    /** The kind's own fields: what its REST endpoint takes as a body, minus `clientEventId` / `occurredAt`. */
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type SyncEventInput = z.infer<typeof syncEventSchema>;

export const syncBatchSchema = z
  .object({
    /** Client-generated id of this batch; stored on every event of it for per-batch reporting. */
    batchId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, '-' and '_'"),
    events: z.array(syncEventSchema).min(1).max(MAX_SYNC_BATCH_EVENTS),
  })
  .strict();
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;
