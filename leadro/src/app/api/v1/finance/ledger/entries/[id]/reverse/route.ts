import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { ledgerIdParams, reverseCharge, reverseEntrySchema } from "@/server/ledger";
import { resolveLedgerEntryJob } from "../../../../_lib/resolve";

/** POST /api/v1/finance/ledger/entries/{id}/reverse: reverse a CHARGE (201; 200 when it was already reversed). */
export const POST = defineRoute({
  schemas: { params: ledgerIdParams, body: reverseEntrySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_payments.edit", resolveLedgerEntryJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await reverseCharge(actorOf(ctx), ctx, input.params.id, input.body);
    return result.replayed ? ok(result) : created(result);
  },
});
