import type { LedgerEntry, LedgerEntryType, LedgerSource } from "@prisma/client";
import { ConflictError, InvalidStateTransitionError, NotFoundError, ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { FinanceJob } from "./job-ref";

/**
 * The ONE way money enters the ledger (spec 11.8). Every posting in the codebase (charges, payments, voids, and the
 * refunds / chargebacks / adjustments of Task 5) goes through `postLedgerEntryInTx` or `reverseLedgerEntryInTx`.
 *
 * Append-only: the database rejects UPDATE / DELETE / TRUNCATE on `LedgerEntry`; a correction is a REVERSAL entry (one per
 * entry, the exact negative, same job / customer / currency: trigger `ledger_entry_guard` + unique index). These functions
 * do NOT check permissions: the calling service enforces them in the same transaction before it posts.
 *
 * Idempotency: `idempotencyKey` is unique per tenant and DETERMINISTIC (derived from the business event, see `keys.ts`),
 * so posting the same event twice, sequentially or concurrently, yields one entry. The insert is
 * `INSERT ... ON CONFLICT DO NOTHING` (`createMany({ skipDuplicates })`): a concurrent duplicate waits for the first
 * transaction and then inserts nothing instead of aborting the caller's transaction, and the existing row is returned.
 */

/** Who posted: a person, or a named machine actor ("system:provider-intake"). Exactly one (DB CHECK `ledger_entry_one_actor`). */
export type LedgerActor = { userId: string } | { system: string };

export type PostableEntryType = Exclude<LedgerEntryType, "REVERSAL">;
export type PostableSource = Exclude<LedgerSource, "REVERSAL">;

/** References to the record that produced the entry; the one matching `source` is required (DB CHECK). */
export interface LedgerRefs {
  outcomeId?: string;
  paymentId?: string;
  refundId?: string;
  chargebackId?: string;
  adjustmentId?: string;
  materialUsageId?: string;
}

export interface PostLedgerEntryInput {
  tenantId: string;
  type: PostableEntryType;
  source: PostableSource;
  /** Signed minor units: positive for CHARGE / PAYMENT, negative for REFUND / CHARGEBACK / MATERIAL_COST, either for ADJUSTMENT. */
  amountMinor: bigint;
  currency: string;
  job: FinanceJob;
  refs?: LedgerRefs;
  idempotencyKey: string;
  actor: LedgerActor;
  /** When the business event happened (the visit, the payment); `recordedAt` is the database clock. */
  occurredAt: Date;
  memo?: string | null;
}

export interface PostResult {
  entry: LedgerEntry;
  /** True when the key had been posted before: nothing new was written (callers then skip their audit event). */
  replayed: boolean;
}

const SOURCE_BY_TYPE: Record<PostableEntryType, readonly PostableSource[]> = {
  CHARGE: ["JOB", "OUTCOME"],
  PAYMENT: ["PAYMENT"],
  REFUND: ["REFUND"],
  CHARGEBACK: ["CHARGEBACK"],
  ADJUSTMENT: ["ADJUSTMENT"],
  MATERIAL_COST: ["MATERIAL_USAGE"],
};

const SOURCE_REF: Record<PostableSource, keyof LedgerRefs | "jobId"> = {
  JOB: "jobId",
  OUTCOME: "outcomeId",
  PAYMENT: "paymentId",
  REFUND: "refundId",
  CHARGEBACK: "chargebackId",
  ADJUSTMENT: "adjustmentId",
  MATERIAL_USAGE: "materialUsageId",
};

const SYSTEM_ACTOR = /^system:[a-z0-9][a-z0-9_.-]{0,62}$/;

/** The fields that define WHAT an entry is: a replay must match them exactly, else the key was reused for something else. */
const IDENTITY_FIELDS = [
  "type",
  "source",
  "amountMinor",
  "currency",
  "jobId",
  "customerId",
  "outcomeId",
  "paymentId",
  "refundId",
  "chargebackId",
  "adjustmentId",
  "materialUsageId",
  "reversesEntryId",
] as const;

function assertSign(type: PostableEntryType, amountMinor: bigint): void {
  const ok =
    amountMinor !== 0n &&
    (type === "ADJUSTMENT" || ((type === "CHARGE" || type === "PAYMENT") ? amountMinor > 0n : amountMinor < 0n));
  if (!ok) {
    throw new ValidationError({
      message: `A ${type} entry has the wrong sign or is zero.`,
      field: "amountMinor",
      details: [{ field: "amountMinor", code: "ledger.wrong_sign", message: `A ${type} entry has the wrong sign or is zero.` }],
    });
  }
}

function actorColumns(actor: LedgerActor): { actorUserId: string | null; systemActor: string | null } {
  if ("userId" in actor) return { actorUserId: actor.userId, systemActor: null };
  // Programming error, not client input: machine actor names are constants in the calling module.
  if (!SYSTEM_ACTOR.test(actor.system)) throw new Error(`invalid system actor "${actor.system}"`);
  return { actorUserId: null, systemActor: actor.system };
}

type EntryData = Omit<LedgerEntry, "id" | "recordedAt">;

/** Inserts unless the key exists, then returns the row under the key (and whether it was there already). */
async function insertIdempotently(tx: TenantTx, data: EntryData): Promise<PostResult> {
  const inserted = await tx.ledgerEntry.createMany({ data: [data], skipDuplicates: true });
  const entry = await tx.ledgerEntry.findUnique({ where: { tenantId_idempotencyKey: { tenantId: data.tenantId, idempotencyKey: data.idempotencyKey } } });
  if (!entry) {
    // Skipped for a DIFFERENT unique rule than the key: the only other one is "one reversal per entry".
    throw new InvalidStateTransitionError({
      message: "This entry has already been reversed.",
      details: [{ field: "entryId", code: "ledger.already_reversed", message: "This entry has already been reversed." }],
    });
  }
  const sameEvent = IDENTITY_FIELDS.every((field) => entry[field] === data[field]);
  if (!sameEvent) {
    throw new ConflictError({
      message: "This posting key was already used for a different ledger entry.",
      details: [{ field: "idempotencyKey", code: "ledger.idempotency_key_reused", message: "This posting key was already used for a different ledger entry." }],
    });
  }
  return { entry, replayed: inserted.count === 0 };
}

/**
 * Posts one entry against a job (idempotent by `idempotencyKey`). The entry's currency must be the job's; customer, unit
 * and legal entity are copied from the job. Throws ValidationError for a wrong sign / source / missing reference and
 * ConflictError when the key already names a different entry.
 */
export async function postLedgerEntryInTx(tx: TenantTx, input: PostLedgerEntryInput): Promise<PostResult> {
  assertSign(input.type, input.amountMinor);
  if (!SOURCE_BY_TYPE[input.type].includes(input.source)) throw new Error(`ledger: source ${input.source} cannot post ${input.type}`);
  const refs = input.refs ?? {};
  const refField = SOURCE_REF[input.source];
  if (refField !== "jobId" && !refs[refField]) throw new Error(`ledger: source ${input.source} needs ${refField}`);
  if (input.currency !== input.job.currency) {
    throw new ValidationError({
      message: "The amount must be in the job's currency.",
      field: "currency",
      details: [{ field: "currency", code: "ledger.currency_mismatch", message: "The amount must be in the job's currency." }],
    });
  }

  return insertIdempotently(tx, {
    tenantId: input.tenantId,
    type: input.type,
    source: input.source,
    amountMinor: input.amountMinor,
    currency: input.currency,
    jobId: input.job.id,
    customerId: input.job.customerId,
    outcomeId: refs.outcomeId ?? null,
    paymentId: refs.paymentId ?? null,
    refundId: refs.refundId ?? null,
    chargebackId: refs.chargebackId ?? null,
    adjustmentId: refs.adjustmentId ?? null,
    materialUsageId: refs.materialUsageId ?? null,
    orgUnitId: input.job.orgUnitId,
    legalEntityId: input.job.legalEntityId,
    reversesEntryId: null,
    idempotencyKey: input.idempotencyKey,
    ...actorColumns(input.actor),
    memo: input.memo ?? null,
    occurredAt: input.occurredAt,
  });
}

export interface ReverseLedgerEntryInput {
  tenantId: string;
  entryId: string;
  actor: LedgerActor;
  /** Why (required, stored as the reversal's memo). */
  reason: string;
  /** Default `reversal:<entryId>`: an entry is reversed at most once, so the key is a function of the entry. */
  idempotencyKey?: string;
  occurredAt?: Date;
}

/**
 * Posts the REVERSAL of one entry: the exact negative, same job / customer / currency, the original's references and
 * unit / legal entity snapshot (so the reversal lands in the same buckets and scope). A reversal itself is never reversed
 * (post a new entry instead). Replays return the existing reversal.
 */
export async function reverseLedgerEntryInTx(tx: TenantTx, input: ReverseLedgerEntryInput): Promise<PostResult> {
  const original = await tx.ledgerEntry.findFirst({ where: { id: input.entryId, tenantId: input.tenantId } });
  if (!original) throw new NotFoundError();
  if (original.type === "REVERSAL") {
    throw new InvalidStateTransitionError({
      message: "A reversal cannot itself be reversed; post a new entry instead.",
      details: [{ field: "entryId", code: "ledger.reversal_not_reversible", message: "A reversal cannot itself be reversed." }],
    });
  }

  return insertIdempotently(tx, {
    tenantId: input.tenantId,
    type: "REVERSAL",
    source: "REVERSAL",
    amountMinor: -original.amountMinor,
    currency: original.currency,
    jobId: original.jobId,
    customerId: original.customerId,
    outcomeId: original.outcomeId,
    paymentId: original.paymentId,
    refundId: original.refundId,
    chargebackId: original.chargebackId,
    adjustmentId: original.adjustmentId,
    materialUsageId: original.materialUsageId,
    orgUnitId: original.orgUnitId,
    legalEntityId: original.legalEntityId,
    reversesEntryId: original.id,
    idempotencyKey: input.idempotencyKey ?? `reversal:${original.id}`,
    ...actorColumns(input.actor),
    memo: input.reason,
    occurredAt: input.occurredAt ?? new Date(),
  });
}
