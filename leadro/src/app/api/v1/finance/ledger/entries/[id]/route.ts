import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getLedgerEntry, ledgerIdParams } from "@/server/ledger";
import { resolveLedgerEntry } from "../../../_lib/resolve";

/** GET /api/v1/finance/ledger/entries/{id}: one entry (and the reversal that cancels it, if any). */
export const GET = defineRoute({
  schemas: { params: ledgerIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_ledger.view", resolveLedgerEntry),
  handler: async ({ ctx, input }) => ok(await getLedgerEntry(actorOf(ctx), input.params.id)),
});
