import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as intakeRoute } from "@/app/api/v1/finance/intake/[tenantSlug]/[provider]/route";
import { GET as intakeEventsRoute } from "@/app/api/v1/finance/intake-events/route";
import { prisma, withTenant } from "@/server/db";
import { hmacSha256Matches, registerPaymentProvider, resetPaymentProviders, type PaymentProvider } from "@/server/payments";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildFinanceWorld, ledgerOf, makeJob, type FinanceWorld } from "./fixtures";

/**
 * The intake is exercised with a provider defined HERE, in the test, the way a real integration would plug in: an HMAC
 * signature over the raw body with a per-tenant secret. Production code ships no provider (spec 28.3).
 */
const SECRET_BY_TENANT = new Map<string, string>();
const testProvider: PaymentProvider = {
  key: "testpay",
  verifyEvent: async ({ tenantId, rawBody, headers }) => {
    const secret = SECRET_BY_TENANT.get(tenantId);
    return secret !== undefined && hmacSha256Matches(secret, rawBody, headers.get("x-test-signature"));
  },
  parseEvent: (rawBody) => {
    const body = JSON.parse(rawBody) as { id?: string; type?: string; data?: { jobId: string; amount: string; currency: string; paymentRef: string } };
    if (!body.id || !body.type) return { ok: false, code: "missing_id" };
    if (!body.data) return { ok: true, event: { externalId: body.id, eventType: body.type } };
    return {
      ok: true,
      event: {
        externalId: body.id,
        eventType: body.type,
        payment: { jobId: body.data.jobId, amountMinor: BigInt(body.data.amount), currency: body.data.currency, providerRef: body.data.paymentRef, method: "CARD" },
      },
    };
  },
};

let w: FinanceWorld;
let slug: string;

beforeAll(async () => {
  w = await buildFinanceWorld("intake");
  slug = (await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).slug;
  SECRET_BY_TENANT.set(w.tenantId, `whsec-${randomUUID()}`);
});
afterEach(resetPaymentProviders);
afterAll(disconnect);

const sign = (body: unknown, secret = SECRET_BY_TENANT.get(w.tenantId) as string) => createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
const deliver = (body: unknown, options: { signature?: string; provider?: string; tenantSlug?: string } = {}) =>
  call(intakeRoute, "POST", "/x", {
    params: { tenantSlug: options.tenantSlug ?? slug, provider: options.provider ?? "testpay" },
    body,
    headers: { "x-test-signature": options.signature ?? sign(body) },
  });
const paymentEvent = (jobId: string, overrides: { id?: string; amount?: string; currency?: string; paymentRef?: string; type?: string } = {}) => ({
  id: overrides.id ?? `evt_${randomUUID()}`,
  type: overrides.type ?? "payment.received",
  data: { jobId, amount: overrides.amount ?? "4500", currency: overrides.currency ?? "USD", paymentRef: overrides.paymentRef ?? `pay_${randomUUID()}` },
});
const intakeRows = () => withTenant(w.tenantId, (tx) => tx.paymentIntakeEvent.findMany({ orderBy: { receivedAt: "asc" } }));
const paymentsOf = (jobId: string) => withTenant(w.tenantId, (tx) => tx.payment.findMany({ where: { jobId } }));

describe("no provider configured (the default)", () => {
  it("refuses every delivery truthfully and writes nothing, for a known or an unknown tenant", async () => {
    const job = await makeJob(w);
    const before = (await intakeRows()).length;
    const response = await deliver(paymentEvent(job.id));
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("payment_provider.not_configured");
    registerPaymentProvider(testProvider);
    const unknownTenant = await deliver(paymentEvent(job.id), { tenantSlug: `no-such-${randomUUID()}` });
    expect(unknownTenant.status).toBe(409);
    expect(unknownTenant.json.error.details[0].code).toBe("payment_provider.not_configured");
    expect((await deliver(paymentEvent(job.id), { provider: "otherpay" })).status).toBe(409);
    expect((await intakeRows()).length).toBe(before);
  });
});

describe("with a provider", () => {
  it("rejects a bad signature with 401, logs it under a hash id, and never squats the event id it claims", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const event = paymentEvent(job.id);
    const forged = await deliver(event, { signature: "0".repeat(64) });
    expect(forged.status).toBe(401);
    const rows = (await intakeRows()).filter((row) => row.signatureValid === false);
    expect(rows.at(-1)).toMatchObject({ status: "REJECTED", rejectionCode: "bad_signature", eventType: "unverified" });
    expect(rows.at(-1)?.externalId.startsWith("unverified:")).toBe(true);
    expect(await paymentsOf(job.id)).toHaveLength(0);

    // The genuine delivery of the same event still goes through.
    const genuine = await deliver(event);
    expect(genuine.json.data).toMatchObject({ status: "ACCEPTED", duplicate: false });
  });

  it("accepts a valid event: event logged first, PROVIDER payment, PAYMENT entry by the system actor, audit", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const event = paymentEvent(job.id, { amount: "4500" });
    const response = await deliver(event);
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ status: "ACCEPTED", rejectionCode: null, duplicate: false });
    const [payment] = await paymentsOf(job.id);
    expect(payment).toMatchObject({ origin: "PROVIDER", status: "RECEIVED", provider: "testpay", providerRef: event.data.paymentRef, amountMinor: 4_500n, intakeEventId: response.json.data.eventId });
    expect(await ledgerOf(w, job.id)).toMatchObject([{ type: "PAYMENT", amountMinor: 4_500n, systemActor: "system:provider-intake", actorUserId: null }]);
    const stored = await withTenant(w.tenantId, (tx) => tx.paymentIntakeEvent.findUniqueOrThrow({ where: { id: response.json.data.eventId } }));
    expect(stored).toMatchObject({ externalId: event.id, signatureValid: true, jobId: job.id, paymentId: payment.id, amountMinor: 4_500n });
    expect(stored.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.parsed)).not.toContain("x-test-signature");
    expect(await auditEvents(w.tenantId, "payment_intake.process", stored.id)).toHaveLength(1);
  });

  it("a duplicate webhook never double-posts (spec 26.4): sequential and concurrent", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const event = paymentEvent(job.id);
    await deliver(event);
    const again = await deliver(event);
    expect(again.json.data).toMatchObject({ status: "ACCEPTED", duplicate: true });

    const job2 = await makeJob(w);
    const burst = paymentEvent(job2.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(burst)));
    expect(results.every((r) => r.status === 200 && r.json.data.status === "ACCEPTED")).toBe(true);
    expect(results.filter((r) => r.json.data.duplicate === false)).toHaveLength(1);
    expect(await paymentsOf(job.id)).toHaveLength(1);
    expect(await paymentsOf(job2.id)).toHaveLength(1);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
    expect(await ledgerOf(w, job2.id)).toHaveLength(1);
  });

  it("a second event about the same provider payment is a DUPLICATE and posts nothing", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const first = paymentEvent(job.id);
    const firstResponse = await deliver(first);
    const second = await deliver(paymentEvent(job.id, { paymentRef: first.data.paymentRef }));
    expect(second.json.data).toMatchObject({ status: "DUPLICATE", rejectionCode: "duplicate_provider_ref" });
    const stored = await withTenant(w.tenantId, (tx) => tx.paymentIntakeEvent.findUniqueOrThrow({ where: { id: second.json.data.eventId } }));
    expect(stored.duplicateOfId).toBe(firstResponse.json.data.eventId);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
  });

  it("P4-R3: concurrent events with different ids about one provider payment: one ACCEPTED, the rest DUPLICATE", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const paymentRef = `pay_${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(paymentEvent(job.id, { paymentRef }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const statuses = results.map((r) => r.json.data.status as string);
    expect(statuses.filter((status) => status === "ACCEPTED")).toHaveLength(1);
    expect(statuses.filter((status) => status === "DUPLICATE")).toHaveLength(5);
    const accepted = results.find((r) => r.json.data.status === "ACCEPTED");
    const rows = await withTenant(w.tenantId, (tx) => tx.paymentIntakeEvent.findMany({ where: { jobId: job.id, status: "DUPLICATE" } }));
    expect(rows.every((row) => row.duplicateOfId === accepted?.json.data.eventId && row.paymentId === null)).toBe(true);
    expect(await paymentsOf(job.id)).toHaveLength(1);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
  });

  it("the same event id with different content is a 409, and nothing changes", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    const event = paymentEvent(job.id);
    await deliver(event);
    const tampered = await deliver({ ...event, data: { ...event.data, amount: "999999" } });
    expect(tampered.status).toBe(409);
    expect(tampered.json.error.details[0].code).toBe("payment_intake.payload_mismatch");
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
  });

  it("validates before touching core records: unknown job, other currency, unsupported type, malformed", async () => {
    registerPaymentProvider(testProvider);
    const job = await makeJob(w);
    expect((await deliver(paymentEvent(`job_${randomUUID().slice(0, 8)}`))).json.data).toMatchObject({ status: "UNMATCHED", rejectionCode: "unknown_job" });
    expect((await deliver(paymentEvent(job.id, { currency: "EUR" }))).json.data).toMatchObject({ status: "REJECTED", rejectionCode: "currency_mismatch" });
    expect((await deliver(paymentEvent(job.id, { type: "payment.refunded" }))).json.data).toMatchObject({ status: "REJECTED", rejectionCode: "unsupported_event_type" });
    expect((await deliver(paymentEvent(job.id, { amount: "0" }))).json.data).toMatchObject({ status: "REJECTED", rejectionCode: "invalid_event_fields" });
    expect((await deliver({ hello: "world" })).json.data).toMatchObject({ status: "REJECTED", rejectionCode: "missing_id" });
    // A job of ANOTHER tenant is unknown here (the lookup runs under this tenant's row-level security).
    const otherWorld = await buildFinanceWorld("intake-other");
    const foreignJob = await makeJob(otherWorld);
    expect((await deliver(paymentEvent(foreignJob.id))).json.data).toMatchObject({ status: "UNMATCHED", rejectionCode: "unknown_job" });
    expect(await paymentsOf(job.id)).toHaveLength(0);
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
    expect(await ledgerOf(otherWorld, foreignJob.id)).toHaveLength(0);
  });

  it("finance reads the intake log (TENANT scope only)", async () => {
    const list = await call(intakeEventsRoute, "GET", "/x", { cookie: w.cookie.finance, query: { provider: "testpay" } });
    expect(list.status).toBe(200);
    expect(list.json.data.length).toBeGreaterThan(0);
    expect(list.json.data[0]).not.toHaveProperty("tenantId");
    expect((await call(intakeEventsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA })).status).toBe(403);
  });
});
