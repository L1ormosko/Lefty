import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { processFieldSyncBatch, syncBatchSchema } from "@/server/field-sync";

/**
 * POST /api/v1/field-sync: applies a batch of offline field events (§8.7). Events are applied in `occurredAt` order;
 * every event answers on its own (`results[]`), and one failure never stops the batch, so the response is `200` whenever
 * the batch itself was well formed. Sending a batch again is safe: events already applied come back as `REPLAYED`.
 *
 * No permission gate here: each event is authorized by the module that owns its type, exactly as its REST endpoint is.
 */
export const POST = defineRoute({
  schemas: { body: syncBatchSchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await processFieldSyncBatch(actorOf(ctx), ctx, input.body)),
});
