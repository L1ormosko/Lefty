import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as resolveRoute } from "@/app/api/v1/finance/reconciliation/exceptions/[id]/resolve/route";
import { GET as getRunRoute } from "@/app/api/v1/finance/reconciliation/runs/[id]/route";
import { withTenant } from "@/server/db";
import { ABANDONED_AFTER_MS } from "@/server/reconciliation";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildFinanceWorld, makeJob, storeSoldOutcome, type FinanceWorld } from "../finance/fixtures";
import { confirmCharge, exceptionsOfJob, failPayment, recordPayment, startRun, storeIntakeEvent, storeRefund } from "./fixtures";

let w: FinanceWorld;

beforeAll(async () => {
  w = await buildFinanceWorld("recon-detect");
});
afterAll(disconnect);

/** A job with a confirmed charge of `charged` and RECEIVED cash payments of `payments`. */
async function chargedJob(charged: number, payments: number[] = []): Promise<{ jobId: string; outcomeId: string }> {
  const job = await makeJob(w);
  const outcomeId = await storeSoldOutcome(w, job.id, { charged: BigInt(charged) });
  expect((await confirmCharge(w, outcomeId, charged)).status).toBe(201);
  for (const amount of payments) await recordPayment(w, job.id, amount);
  return { jobId: job.id, outcomeId };
}

const kindsOf = (rows: Array<Record<string, unknown>>) => rows.map((row) => row.kind).sort();

describe("a run", () => {
  it("is COMPLETED with stored totals and an audit trail", async () => {
    const { jobId } = await chargedJob(10_000, [4_000]);
    const response = await startRun(w);
    expect(response.status).toBe(201);
    const { run, findings } = response.json.data;
    expect(run).toMatchObject({ status: "COMPLETED", legalEntityId: w.legalEntityId, coverage: "LEGAL_ENTITY", currency: "USD", failureReason: null });
    expect(run.completedAt).not.toBeNull();
    expect(run.jobsExamined).toBeGreaterThanOrEqual(1);
    expect(BigInt(run.expectedMinor)).toBeGreaterThanOrEqual(10_000n);
    expect(BigInt(run.differenceMinor)).toBe(BigInt(run.expectedMinor) - BigInt(run.recordedMinor));
    expect(findings.created).toBeGreaterThanOrEqual(1);
    expect(kindsOf(await exceptionsOfJob(w, jobId))).toEqual(["PARTIAL_PAYMENT"]);

    const stored = await withTenant(w.tenantId, (tx) => tx.reconciliationRun.findFirstOrThrow({ where: { id: run.id } }));
    expect(stored).toMatchObject({ status: "COMPLETED", startedById: w.finance.userId });
    expect(await auditEvents(w.tenantId, "reconciliation_run.start", run.id)).toHaveLength(1);
    expect(await auditEvents(w.tenantId, "reconciliation_run.complete", run.id)).toHaveLength(1);

    const detail = (await call(getRunRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: run.id } })).json.data;
    expect(detail.raised.total).toBe(findings.created);
    expect(detail.alreadyOpen).toBe(findings.alreadyOpen);
  });

  it("refuses an empty or overlong period", async () => {
    const empty = await startRun(w, { periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z" });
    expect(empty.status).toBe(400);
    expect(empty.json.error.details[0].code).toBe("reconciliation.period_empty");
    const long = await startRun(w, { periodStart: "2025-01-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z" });
    expect(long.json.error.details[0].code).toBe("reconciliation.period_too_long");
  });

  it("marks a RUNNING run of the same scope that a crash left behind as FAILED (abandoned)", async () => {
    const stale = await withTenant(w.tenantId, (tx) =>
      tx.reconciliationRun.create({
        data: {
          tenantId: w.tenantId,
          legalEntityId: w.legalEntityId,
          currency: "USD",
          periodStart: new Date("2026-09-01T00:00:00Z"),
          periodEnd: new Date("2026-10-01T00:00:00Z"),
          startedAt: new Date(Date.now() - ABANDONED_AFTER_MS - 60_000),
        },
      }),
    );
    expect((await startRun(w)).status).toBe(201);
    const after = await withTenant(w.tenantId, (tx) => tx.reconciliationRun.findFirstOrThrow({ where: { id: stale.id } }));
    expect(after).toMatchObject({ status: "FAILED", failureReason: "abandoned" });
    expect(await auditEvents(w.tenantId, "reconciliation_run.fail", stale.id)).toHaveLength(1);
  });
});

describe("exception detection", () => {
  it("expected vs recorded per job: unpaid, partial, overpaid, and nothing for a paid job", async () => {
    const unpaid = await chargedJob(8_000);
    const partial = await chargedJob(10_000, [2_500]);
    const overpaid = await chargedJob(5_000, [3_000, 4_000]);
    const paid = await chargedJob(6_000, [6_000]);
    await startRun(w);

    const [unpaidRow] = await exceptionsOfJob(w, unpaid.jobId);
    expect(unpaidRow).toMatchObject({ kind: "UNPAID", status: "OPEN", expectedAmountMinor: "8000", recordedAmountMinor: "0", currency: "USD", orgUnitId: w.units.cityA });
    expect(await exceptionsOfJob(w, partial.jobId)).toMatchObject([{ kind: "PARTIAL_PAYMENT", expectedAmountMinor: "10000", recordedAmountMinor: "2500" }]);
    expect(await exceptionsOfJob(w, overpaid.jobId)).toMatchObject([{ kind: "OVERPAYMENT", expectedAmountMinor: "5000", recordedAmountMinor: "7000" }]);
    expect(await exceptionsOfJob(w, paid.jobId)).toEqual([]);
  });

  it("a failed payment", async () => {
    const { jobId } = await chargedJob(3_000, [3_000]);
    const pending = await recordPayment(w, jobId, 1_200, "PENDING");
    expect((await failPayment(w, pending)).status).toBe(200);
    await startRun(w);
    expect(await exceptionsOfJob(w, jobId)).toMatchObject([{ kind: "FAILED_PAYMENT", paymentId: pending, expectedAmountMinor: "1200", recordedAmountMinor: "0" }]);
  });

  it("an outcome whose charged amount no longer matches the ledger CHARGE", async () => {
    const { jobId, outcomeId } = await chargedJob(5_000, [4_000]);
    // A manager corrected the outcome after finance confirmed the charge (corrections update the outcome in place).
    await withTenant(w.tenantId, (tx) => tx.jobOutcome.update({ where: { id: outcomeId }, data: { chargedAmountMinor: 4_000n } }));
    await startRun(w);
    const rows = await exceptionsOfJob(w, jobId);
    expect(rows.find((row) => row.kind === "OUTCOME_LEDGER_MISMATCH")).toMatchObject({ outcomeId, expectedAmountMinor: "4000", recordedAmountMinor: "5000", moneyRedacted: false });
  });

  it("a SOLD outcome finance has not confirmed yet", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 7_500n, collected: 7_500n });
    await startRun(w);
    expect(await exceptionsOfJob(w, job.id)).toMatchObject([
      { kind: "OTHER", code: "finance_confirmation_pending", outcomeId, expectedAmountMinor: "7500", details: { chargePending: true, collectionPending: true } },
    ]);
  });

  it("a refund without a received payment, and a refund of a failed payment", async () => {
    const noPayment = await makeJob(w);
    const refundA = await storeRefund(w, noPayment.id, 1_000n);
    const { jobId } = await chargedJob(2_000, [2_000]);
    const pending = await recordPayment(w, jobId, 900, "PENDING");
    await failPayment(w, pending);
    const refundB = await storeRefund(w, jobId, 900n, pending);
    const covered = await chargedJob(2_000, [2_000]);
    await storeRefund(w, covered.jobId, 500n);
    await startRun(w);

    expect(await exceptionsOfJob(w, noPayment.id)).toMatchObject([{ kind: "REFUND_WITHOUT_PAYMENT", code: "refund_no_payment", refundId: refundA, expectedAmountMinor: "1000", recordedAmountMinor: "0" }]);
    const rows = await exceptionsOfJob(w, jobId);
    expect(rows.find((row) => row.kind === "REFUND_WITHOUT_PAYMENT")).toMatchObject({ code: "refund_payment_not_received", refundId: refundB, paymentId: pending });
    expect((await exceptionsOfJob(w, covered.jobId)).filter((row) => row.kind === "REFUND_WITHOUT_PAYMENT")).toEqual([]);
  });

  it("duplicate and unmatched provider events; an event naming no job only in a tenant-wide run", async () => {
    const { jobId } = await chargedJob(4_500, [4_500]);
    const first = await storeIntakeEvent(w, { status: "UNMATCHED", jobId: null, currency: "USD" });
    const duplicate = await storeIntakeEvent(w, { status: "DUPLICATE", jobId, duplicateOfId: first });
    await startRun(w);
    expect(await exceptionsOfJob(w, jobId)).toMatchObject([{ kind: "DUPLICATE_EXTERNAL_EVENT", intakeEventId: duplicate, recordedAmountMinor: "4500", details: { duplicateOfId: first } }]);
    const unmatchedRows = () => withTenant(w.tenantId, (tx) => tx.reconciliationException.findMany({ where: { intakeEventId: first } }));
    expect(await unmatchedRows()).toHaveLength(0);

    expect((await startRun(w, { legalEntityId: null })).json.data.run.coverage).toBe("TENANT");
    expect(await unmatchedRows()).toMatchObject([{ kind: "UNMATCHED_PROVIDER_EVENT", orgUnitId: null, jobId: null }]);
  });

  it("only looks at the run's currency and period", async () => {
    const { jobId } = await chargedJob(9_000);
    await startRun(w, { currency: "EUR" });
    await startRun(w, { periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-02-01T00:00:00Z" });
    expect(await exceptionsOfJob(w, jobId)).toEqual([]);
  });
});

describe("re-runs are idempotent", () => {
  it("a re-run of the same period does not duplicate open exceptions; it records that it saw them again", async () => {
    const { jobId } = await chargedJob(10_000, [1_000]);
    const first = (await startRun(w)).json.data.run;
    const [exception] = await exceptionsOfJob(w, jobId);
    expect(exception.details).toMatchObject({ lastSeenRunId: first.id, latestRecordedMinor: "1000" });

    await recordPayment(w, jobId, 2_000);
    const second = (await startRun(w)).json.data;
    expect(second.findings.alreadyOpen).toBeGreaterThanOrEqual(1);
    const rows = await exceptionsOfJob(w, jobId);
    expect(rows).toHaveLength(1);
    // What was found stays frozen; the latest view moves with the re-run.
    expect(rows[0]).toMatchObject({ id: exception.id, runId: first.id, recordedAmountMinor: "1000", details: { lastSeenRunId: second.run.id, latestRecordedMinor: "3000" } });
  });

  it("concurrent runs of the same scope raise each exception once", async () => {
    const { jobId } = await chargedJob(12_000, [100]);
    const results = await Promise.all([startRun(w), startRun(w), startRun(w)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await exceptionsOfJob(w, jobId)).toHaveLength(1);
  });

  it("a resolution stands for the same amounts; a changed situation raises a new exception", async () => {
    const { jobId } = await chargedJob(10_000, [5_000]);
    await startRun(w);
    const [exception] = await exceptionsOfJob(w, jobId);
    const resolved = await call(resolveRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: exception.id as string }, body: { reason: "Customer pays the rest next week" } });
    expect(resolved.status).toBe(200);
    expect((await startRun(w)).json.data.findings.acceptedEarlier).toBeGreaterThanOrEqual(1);
    expect(await exceptionsOfJob(w, jobId)).toHaveLength(1);

    await recordPayment(w, jobId, 1_000);
    await startRun(w);
    const rows = await exceptionsOfJob(w, jobId);
    expect(rows.map((row) => [row.status, row.recordedAmountMinor])).toEqual([
      ["OPEN", "6000"],
      ["RESOLVED", "5000"],
    ]);
  });
});
