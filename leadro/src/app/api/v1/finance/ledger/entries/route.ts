import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listLedgerEntries, listLedgerQuerySchema } from "@/server/ledger";

/** GET /api/v1/finance/ledger/entries: entries in the caller's scope (unit / legal entity snapshot), newest first. */
export const GET = defineRoute({
  schemas: { query: listLedgerQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view"),
  handler: async ({ ctx, input }) => respond(200, await listLedgerEntries(actorOf(ctx), input.query)),
});
