import { z } from "zod";
import { LEDGER_ENTRY_TYPES } from "@/lib/ledger-balances";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the ledger API (`/api/v1/finance/ledger/**`, balances). Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const ledgerIdParams = z.object({ id });

/** Optional `occurredAt` window `[occurredFrom, occurredTo)` for customer / legal-entity balances. */
export const balanceQuerySchema = z.object({ occurredFrom: instant.optional(), occurredTo: instant.optional() }).strict();
export type BalanceQuery = z.infer<typeof balanceQuerySchema>;

export const jobBalancesQuerySchema = pageQuerySchema.extend({ customerId: id.optional() }).strict();
export type JobBalancesQuery = z.infer<typeof jobBalancesQuerySchema>;

export const listLedgerQuerySchema = pageQuerySchema
  .extend({
    jobId: id.optional(),
    customerId: id.optional(),
    outcomeId: id.optional(),
    paymentId: id.optional(),
    legalEntityId: id.optional(),
    type: z.enum(LEDGER_ENTRY_TYPES).optional(),
    occurredFrom: instant.optional(),
    occurredTo: instant.optional(),
  })
  .strict();
export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>;

/** Reversing a CHARGE (the only correction of a posted charge: entries are never edited). */
export const reverseEntrySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;
