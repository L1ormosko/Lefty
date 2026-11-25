import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as disputeRoute } from "@/app/api/v1/finance/chargebacks/[id]/dispute/route";
import { POST as lostRoute } from "@/app/api/v1/finance/chargebacks/[id]/lost/route";
import { GET as getRoute } from "@/app/api/v1/finance/chargebacks/[id]/route";
import { POST as wonRoute } from "@/app/api/v1/finance/chargebacks/[id]/won/route";
import { POST as writeOffRoute } from "@/app/api/v1/finance/chargebacks/[id]/write-off/route";
import { GET as listRoute, POST as recordRoute } from "@/app/api/v1/finance/chargebacks/route";
import { POST as intakeRoute } from "@/app/api/v1/finance/intake/[tenantSlug]/[provider]/route";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { prisma, withTenant } from "@/server/db";
import { hmacSha256Matches, registerPaymentProvider, resetPaymentProviders, type PaymentProvider } from "@/server/payments";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob } from "../finance/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { addPolicy, approve, buildCorrectionsWorld, flagsOf, idempotencyHeader, receivedPayment, reject, type CorrectionsWorld } from "./fixtures";

/** A test-only HMAC provider (production ships none, spec 28.3) that knows payment and chargeback events. */
const SECRETS = new Map<string, string>();
const testProvider: PaymentProvider = {
  key: "testpay",
  verifyEvent: async ({ tenantId, rawBody, headers }) => {
    const secret = SECRETS.get(tenantId);
    return secret !== undefined && hmacSha256Matches(secret, rawBody, headers.get("x-test-signature"));
  },
  parseEvent: (rawBody) => {
    const body = JSON.parse(rawBody) as { id: string; type: string; payment?: { jobId: string; amount: string; ref: string }; chargeback?: { paymentRef: string; ref: string; amount: string; currency?: string; reason?: string } };
    const event = { externalId: body.id, eventType: body.type };
    if (body.payment) return { ok: true, event: { ...event, payment: { jobId: body.payment.jobId, amountMinor: BigInt(body.payment.amount), currency: "USD", providerRef: body.payment.ref, method: "CARD" } } };
    if (body.chargeback) {
      const c = body.chargeback;
      return { ok: true, event: { ...event, chargeback: { paymentProviderRef: c.paymentRef, chargebackRef: c.ref, amountMinor: BigInt(c.amount), currency: c.currency ?? "USD", reasonCode: c.reason } } };
    }
    return { ok: true, event };
  },
};

let w: CorrectionsWorld;
let slug: string;

beforeAll(async () => {
  w = await buildCorrectionsWorld("chargebacks");
  slug = (await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).slug;
  SECRETS.set(w.tenantId, `whsec-${randomUUID()}`);
  // Writing off 100.00 and more needs one approval; smaller write-offs need nobody.
  await addPolicy(w, "CHARGEBACK_WRITE_OFF", { min: 10_000 });
});
afterEach(resetPaymentProviders);
afterAll(disconnect);

const deliver = (body: unknown) => {
  registerPaymentProvider(testProvider);
  const signature = createHmac("sha256", SECRETS.get(w.tenantId) as string).update(JSON.stringify(body)).digest("hex");
  return call(intakeRoute, "POST", "/x", { params: { tenantSlug: slug, provider: "testpay" }, body, headers: { "x-test-signature": signature } });
};
const record = (body: Record<string, unknown>, cookie = w.cookie.finance, key: string | null = randomUUID()) =>
  call(recordRoute, "POST", "/api/v1/finance/chargebacks", { cookie, body, headers: key ? idempotencyHeader(key) : {} });
const step = (route: typeof wonRoute, id: string, body: Record<string, unknown> = {}, cookie = w.cookie.finance) => call(route, "POST", "/x", { cookie, params: { id }, body });
const balance = async (jobId: string) => (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobId } })).json.data.balances[0];

describe("manual chargebacks", () => {
  it("opening posts one CHARGEBACK entry and a review flag; winning reverses it; the record is never edited", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 9_000);
    const response = await record({ paymentId, amountMinor: 9_000, reasonCode: "10.4", notes: "Customer says card was stolen" });
    expect(response.status).toBe(201);
    const chargeback = response.json.data.chargeback;
    expect(chargeback).toMatchObject({ status: "OPEN", amountMinor: "9000", paymentId, recordedById: w.finance.userId, provider: null, reasonCode: "10.4" });
    expect(chargeback.idempotencyKey).toBeUndefined();
    expect(await balance(job.id)).toMatchObject({ chargedBackMinor: "9000", netCollectedMinor: "0" });
    expect((await flagsOf(w, job.id)).map((f) => [f.reasonCode, f.chargebackId])).toEqual([["chargeback.opened", chargeback.id]]);

    expect((await step(disputeRoute, chargeback.id, { notes: "Evidence: signed work order" })).json.data.chargeback.status).toBe("DISPUTED");
    const won = await step(wonRoute, chargeback.id);
    expect(won.json.data.chargeback).toMatchObject({ status: "WON" });
    expect(won.json.data.chargeback.resolvedAt).not.toBeNull();
    expect((await step(wonRoute, chargeback.id)).json.data.replayed).toBe(true);

    const entries = await ledgerOf(w, job.id);
    const opened = entries.find((e) => e.type === "CHARGEBACK");
    expect(entries.map((e) => [e.type, e.amountMinor])).toEqual([
      ["PAYMENT", 9_000n],
      ["CHARGEBACK", -9_000n],
      ["REVERSAL", 9_000n],
    ]);
    expect(entries[2]).toMatchObject({ reversesEntryId: opened?.id, chargebackId: chargeback.id, idempotencyKey: `chargeback:${chargeback.id}:won` });
    expect(await balance(job.id)).toMatchObject({ chargedBackMinor: "0", netCollectedMinor: "9000" });
    // A won dispute is final.
    expect((await step(lostRoute, chargeback.id)).json.error.code).toBe("INVALID_STATE_TRANSITION");
    await expect(withTenant(w.tenantId, (tx) => tx.chargeback.update({ where: { id: chargeback.id }, data: { amountMinor: 1n } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.chargeback.delete({ where: { id: chargeback.id } }))).rejects.toThrow();
  });

  it("validates: key required and replayed, payment received, amount within what is left, same currency", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 4_000);
    expect((await record({ paymentId, amountMinor: 100 }, w.cookie.finance, null)).json.error.details[0].code).toBe("chargeback.idempotency_key_required");
    const key = randomUUID();
    const first = await record({ paymentId, amountMinor: 3_000 }, w.cookie.finance, key);
    expect((await record({ paymentId, amountMinor: 3_000 }, w.cookie.finance, key)).json.data.chargeback.id).toBe(first.json.data.chargeback.id);
    expect((await record({ paymentId, amountMinor: 1_500 })).json.error.details[0].code).toBe("chargeback.exceeds_payment");
    expect((await record({ paymentId, amountMinor: 100, currency: "EUR" })).json.error.details[0].code).toBe("chargeback.currency_mismatch");
    expect((await ledgerOf(w, job.id)).filter((e) => e.type === "CHARGEBACK")).toHaveLength(1);
  });

  it("only finance chargeback holders record or move them; scope is the job's unit", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 4_000);
    // Managers and the COO only VIEW chargebacks (templates); technicians have no finance access.
    expect((await record({ paymentId, amountMinor: 100 }, w.cookie.cityManagerA)).status).toBe(403);
    expect((await record({ paymentId, amountMinor: 100 }, w.cooCookie)).status).toBe(403);
    const id = (await record({ paymentId, amountMinor: 100 })).json.data.chargeback.id as string;
    expect((await step(disputeRoute, id, {}, w.cookie.cityManagerA)).status).toBe(403);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id } })).status).toBe(200);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { id } })).status).toBe(404);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, query: { jobId: job.id } })).json.data).toEqual([]);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.techA1 })).status).toBe(403);
  });
});

describe("write-off of a lost chargeback", () => {
  it("small: written off at once with a posted system adjustment that forgives exactly the lost amount", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    const id = (await record({ paymentId, amountMinor: 5_000 })).json.data.chargeback.id as string;
    expect((await step(writeOffRoute, id, { reason: "x" })).json.error.code).toBe("INVALID_STATE_TRANSITION");
    await step(lostRoute, id);
    const written = await step(writeOffRoute, id, { reason: "Not worth pursuing" });
    expect(written.json.data).toMatchObject({ approvalRequired: false, chargeback: { status: "WRITTEN_OFF" } });
    const adjustment = await withTenant(w.tenantId, (tx) => tx.adjustment.findFirstOrThrow({ where: { jobId: job.id } }));
    expect(adjustment).toMatchObject({ amountMinor: -5_000n, reasonCode: "chargeback_write_off", status: "POSTED", idempotencyKey: `chargeback:${id}:write_off`, requestedById: w.finance.userId });
    expect((await ledgerOf(w, job.id)).map((e) => [e.type, e.amountMinor])).toEqual([
      ["PAYMENT", 5_000n],
      ["CHARGEBACK", -5_000n],
      ["ADJUSTMENT", -5_000n],
    ]);
    expect(await auditEvents(w.tenantId, "chargeback.written_off", id)).toHaveLength(1);
  });

  it("large: needs an approver who neither requested it nor recorded the chargeback; a rejection returns it to LOST", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 30_000);
    // Recorded by the Owner, write-off requested by the Finance Director: neither may decide.
    const id = (await record({ paymentId, amountMinor: 30_000 }, w.cookie.ceo)).json.data.chargeback.id as string;
    await step(lostRoute, id);
    const first = (await step(writeOffRoute, id, { reason: "Customer insolvent" })).json.data;
    expect(first).toMatchObject({ approvalRequired: true, chargeback: { status: "WRITE_OFF_PENDING_APPROVAL", writeOffApprovalRequestId: first.approvalRequestId } });
    await expect(approve(w.finance, first.approvalRequestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approve(w.ceo, first.approvalRequestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await reject(w.approver2, first.approvalRequestId, "Send it to collections first");
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id } })).json.data.status).toBe("LOST");

    // A second attempt gets its own approval request (key attempt 2) and, approved, writes off once.
    const second = (await step(writeOffRoute, id, { reason: "Collections failed" })).json.data;
    expect(second.approvalRequestId).not.toBe(first.approvalRequestId);
    await approve(w.approver2, second.approvalRequestId);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id } })).json.data.status).toBe("WRITTEN_OFF");
    const adjustment = await withTenant(w.tenantId, (tx) => tx.adjustment.findFirstOrThrow({ where: { jobId: job.id } }));
    expect(adjustment).toMatchObject({ amountMinor: -30_000n, approvalRequestId: second.approvalRequestId, requestedById: w.finance.userId, reason: "Collections failed" });
    const adjustmentEntry = (await ledgerOf(w, job.id)).find((e) => e.type === "ADJUSTMENT");
    expect(adjustmentEntry).toMatchObject({ actorUserId: w.approver2.userId, amountMinor: -30_000n });
  });
});

describe("provider chargebacks through the intake", () => {
  it("validates before writing: unknown payment, currency, duplicates; a valid one opens once with the intake as actor", async () => {
    const job = await makeJob(w);
    const paymentRef = `pay_${randomUUID()}`;
    const paid = await deliver({ id: `evt_${randomUUID()}`, type: "payment.received", payment: { jobId: job.id, amount: "7000", ref: paymentRef } });
    expect(paid.json.data.status).toBe("ACCEPTED");

    const unknown = await deliver({ id: `evt_${randomUUID()}`, type: "chargeback.opened", chargeback: { paymentRef: "pay_nope", ref: `cb_${randomUUID()}`, amount: "100" } });
    expect(unknown.json.data).toMatchObject({ status: "UNMATCHED", rejectionCode: "unknown_payment" });
    const euro = await deliver({ id: `evt_${randomUUID()}`, type: "chargeback.opened", chargeback: { paymentRef, ref: `cb_${randomUUID()}`, amount: "100", currency: "EUR" } });
    expect(euro.json.data).toMatchObject({ status: "REJECTED", rejectionCode: "currency_mismatch" });
    const missing = await deliver({ id: `evt_${randomUUID()}`, type: "chargeback.opened" });
    expect(missing.json.data).toMatchObject({ status: "REJECTED", rejectionCode: "missing_chargeback" });

    const chargebackRef = `cb_${randomUUID()}`;
    const event = { id: `evt_${randomUUID()}`, type: "chargeback.opened", chargeback: { paymentRef, ref: chargebackRef, amount: "7000", reason: "fraud" } };
    const accepted = await deliver(event);
    expect(accepted.json.data).toMatchObject({ status: "ACCEPTED", duplicate: false });
    // The same delivery again, concurrently, and a NEW event about the same chargeback: posted once.
    const repeats = await Promise.all([deliver(event), deliver(event)]);
    expect(repeats.every((r) => r.json.data.duplicate === true)).toBe(true);
    const sameRef = await deliver({ ...event, id: `evt_${randomUUID()}` });
    expect(sameRef.json.data).toMatchObject({ status: "DUPLICATE", rejectionCode: "duplicate_provider_ref" });

    const chargebacks = await withTenant(w.tenantId, (tx) => tx.chargeback.findMany({ where: { jobId: job.id } }));
    expect(chargebacks).toHaveLength(1);
    expect(chargebacks[0]).toMatchObject({ provider: "testpay", providerRef: chargebackRef, reasonCode: "fraud", recordedById: null, intakeEventId: accepted.json.data.eventId });
    const entries = (await ledgerOf(w, job.id)).filter((e) => e.type === "CHARGEBACK");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amountMinor: -7_000n, systemActor: "system:provider-intake", actorUserId: null });
    expect((await flagsOf(w, job.id)).map((f) => f.reasonCode)).toEqual(["chargeback.opened"]);
    const intake = await withTenant(w.tenantId, (tx) => tx.paymentIntakeEvent.findUniqueOrThrow({ where: { id: accepted.json.data.eventId } }));
    expect(intake.parsed).toMatchObject({ chargebackRef, amountMinor: "7000", paymentProviderRef: paymentRef });
  });
});
