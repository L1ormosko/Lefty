import { z } from "zod";
import { currencyCodeSchema } from "@/lib/money";
import { RECONCILIATION_EXCEPTION_KINDS, RECONCILIATION_EXCEPTION_STATUSES, RECONCILIATION_RUN_STATUSES } from "@/lib/reconciliation-rules";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the reconciliation API (`/api/v1/finance/reconciliation/**`). Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const reason = z.string().trim().min(1).max(1000);

export const reconciliationIdParams = z.object({ id });

/**
 * Starting a run: one period `[periodStart, periodEnd)` of one currency, for one legal entity, or for the whole tenant
 * when `legalEntityId` is omitted or null (needs a TENANT scope).
 */
export const startRunSchema = z
  .object({
    legalEntityId: id.nullable().optional(),
    currency: currencyCodeSchema,
    periodStart: instant,
    periodEnd: instant,
  })
  .strict();
export type StartRunInput = z.infer<typeof startRunSchema>;

export const listRunsQuerySchema = pageQuerySchema
  .extend({
    legalEntityId: id.optional(),
    currency: currencyCodeSchema.optional(),
    status: z.enum(RECONCILIATION_RUN_STATUSES).optional(),
  })
  .strict();
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listExceptionsQuerySchema = pageQuerySchema
  .extend({
    runId: id.optional(),
    jobId: id.optional(),
    kind: z.enum(RECONCILIATION_EXCEPTION_KINDS).optional(),
    status: z.enum(RECONCILIATION_EXCEPTION_STATUSES).optional(),
    /** `unresolved` = OPEN or ASSIGNED (the work queue). Ignored when `status` is given. */
    state: z.enum(["unresolved", "all"]).default("all"),
    /** A user id, or `me` for the caller. */
    assignedToId: id.optional(),
    currency: currencyCodeSchema.optional(),
  })
  .strict();
export type ListExceptionsQuery = z.infer<typeof listExceptionsQuerySchema>;

export const summaryQuerySchema = z.object({ legalEntityId: id.optional(), currency: currencyCodeSchema.optional() }).strict();
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

export const assignExceptionSchema = z.object({ assignedToId: id, note: reason.optional() }).strict();
export type AssignExceptionInput = z.infer<typeof assignExceptionSchema>;

export const unassignExceptionSchema = z.object({ reason: reason.optional() }).strict();
export type UnassignExceptionInput = z.infer<typeof unassignExceptionSchema>;

/** Resolving always needs the reason (kept on the exception and the audit trail; DB CHECK too). */
export const resolveExceptionSchema = z.object({ reason }).strict();
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
