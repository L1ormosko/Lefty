import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { jobBalanceInTx, loadFinanceJob, postLedgerEntryInTx, reverseLedgerEntryInTx, type FinanceJob, type PostLedgerEntryInput } from "@/server/ledger";
import { disconnect } from "../authz/fixtures";
import { buildFinanceWorld, makeJob, storeSoldOutcome, type FinanceWorld } from "./fixtures";

let w: FinanceWorld;
let job: FinanceJob;
let outcomeId: string;
let counter = 0;

beforeAll(async () => {
  w = await buildFinanceWorld("ledger");
  const created = await makeJob(w);
  job = (await withTenant(w.tenantId, (tx) => loadFinanceJob(tx, w.tenantId, created.id))) as FinanceJob;
  outcomeId = await storeSoldOutcome(w, job.id, { charged: 10_000n });
});
afterAll(disconnect);

const charge = (overrides: Partial<PostLedgerEntryInput> = {}): PostLedgerEntryInput => ({
  tenantId: w.tenantId,
  type: "CHARGE",
  source: "OUTCOME",
  amountMinor: 10_000n,
  currency: job.currency,
  job,
  refs: { outcomeId },
  idempotencyKey: `test:charge:${++counter}`,
  actor: { userId: w.finance.userId },
  occurredAt: new Date(),
  ...overrides,
});

const post = (input: PostLedgerEntryInput) => withTenant(w.tenantId, (tx) => postLedgerEntryInTx(tx, input));
const reverse = (entryId: string, idempotencyKey?: string) =>
  withTenant(w.tenantId, (tx) => reverseLedgerEntryInTx(tx, { tenantId: w.tenantId, entryId, actor: { userId: w.finance.userId }, reason: "test", idempotencyKey }));

describe("the ledger is append-only (spec 11.8)", () => {
  it("rejects UPDATE and DELETE of an entry at the database", async () => {
    const { entry } = await post(charge());
    await expect(withTenant(w.tenantId, (tx) => tx.ledgerEntry.update({ where: { id: entry.id }, data: { memo: "edited" } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.ledgerEntry.delete({ where: { id: entry.id } }))).rejects.toThrow();
    const stored = await withTenant(w.tenantId, (tx) => tx.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } }));
    expect(stored.memo).toBeNull();
  });
});

describe("posting is idempotent by key", () => {
  it("returns the existing entry for the same key and content, and writes nothing new", async () => {
    const input = charge();
    const first = await post(input);
    const second = await post(input);
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, entry: { id: first.entry.id } });
    const count = await withTenant(w.tenantId, (tx) => tx.ledgerEntry.count({ where: { idempotencyKey: input.idempotencyKey } }));
    expect(count).toBe(1);
  });

  it("refuses the same key for a different amount (409 ledger.idempotency_key_reused)", async () => {
    const input = charge();
    await post(input);
    await expect(post({ ...input, amountMinor: 9_999n })).rejects.toMatchObject({ code: "CONFLICT", details: [{ code: "ledger.idempotency_key_reused" }] });
  });

  it("posts ONE entry when the same event is posted concurrently", async () => {
    const input = charge();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(input)));
    expect(new Set(results.map((result) => result.entry.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const count = await withTenant(w.tenantId, (tx) => tx.ledgerEntry.count({ where: { idempotencyKey: input.idempotencyKey } }));
    expect(count).toBe(1);
  });

  it("copies customer, unit and legal entity from the job and refuses another currency or a wrong sign", async () => {
    const { entry } = await post(charge());
    expect(entry).toMatchObject({ jobId: job.id, customerId: job.customerId, orgUnitId: job.orgUnitId, legalEntityId: w.legalEntityId, actorUserId: w.finance.userId, systemActor: null });
    await expect(post(charge({ currency: "EUR" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ code: "ledger.currency_mismatch" }] });
    await expect(post(charge({ amountMinor: -5n }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ code: "ledger.wrong_sign" }] });
    await expect(post(charge({ type: "PAYMENT", source: "PAYMENT", refs: {}, amountMinor: 0n }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("corrections are reversals", () => {
  it("a reversal is the exact negative, keeps the references, and is posted once", async () => {
    const { entry } = await post(charge({ amountMinor: 7_000n }));
    const first = await reverse(entry.id);
    expect(first.entry).toMatchObject({ type: "REVERSAL", source: "REVERSAL", amountMinor: -7_000n, reversesEntryId: entry.id, outcomeId, jobId: job.id, idempotencyKey: `reversal:${entry.id}` });
    const again = await reverse(entry.id);
    expect(again).toMatchObject({ replayed: true, entry: { id: first.entry.id } });
  });

  it("refuses a second reversal of the same entry under another key, and reversing a reversal", async () => {
    const { entry } = await post(charge());
    const { entry: reversal } = await reverse(entry.id);
    await expect(reverse(entry.id, "another-key")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", details: [{ code: "ledger.already_reversed" }] });
    await expect(reverse(reversal.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", details: [{ code: "ledger.reversal_not_reversible" }] });
  });

  it("the database refuses a reversal that is not the exact negative", async () => {
    const { entry } = await post(charge());
    await expect(
      withTenant(w.tenantId, (tx) =>
        tx.ledgerEntry.create({
          data: {
            tenantId: w.tenantId, type: "REVERSAL", source: "REVERSAL", amountMinor: -1n, currency: job.currency, jobId: job.id,
            customerId: job.customerId, reversesEntryId: entry.id, idempotencyKey: `bad-reversal-${entry.id}`, actorUserId: w.finance.userId, occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("balances are derived: a reversed charge drops out of charged", async () => {
    const fresh = await makeJob(w);
    const freshJob = (await withTenant(w.tenantId, (tx) => loadFinanceJob(tx, w.tenantId, fresh.id))) as FinanceJob;
    const freshOutcome = await storeSoldOutcome(w, fresh.id, { charged: 5_000n });
    const { entry } = await post(charge({ job: freshJob, refs: { outcomeId: freshOutcome }, amountMinor: 5_000n }));
    const before = await withTenant(w.tenantId, (tx) => jobBalanceInTx(tx, w.tenantId, fresh.id));
    expect(before[0]).toMatchObject({ chargedMinor: 5_000n, outstandingMinor: 5_000n, paymentStatus: "UNPAID" });
    await reverse(entry.id);
    const after = await withTenant(w.tenantId, (tx) => jobBalanceInTx(tx, w.tenantId, fresh.id));
    expect(after[0]).toMatchObject({ chargedMinor: 0n, outstandingMinor: 0n, paymentStatus: "NOT_CHARGED" });
  });
});
