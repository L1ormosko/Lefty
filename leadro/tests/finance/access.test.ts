import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as candidatesRoute } from "@/app/api/v1/dispatch/jobs/[id]/candidates/route";
import { GET as customerBalanceRoute } from "@/app/api/v1/finance/customers/[id]/balance/route";
import { GET as jobBalancesRoute } from "@/app/api/v1/finance/job-balances/route";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { GET as legalEntityBalanceRoute } from "@/app/api/v1/finance/legal-entities/[id]/balance/route";
import { GET as getEntryRoute } from "@/app/api/v1/finance/ledger/entries/[id]/route";
import { GET as listEntriesRoute } from "@/app/api/v1/finance/ledger/entries/route";
import { GET as paymentProvidersRoute } from "@/app/api/v1/finance/payment-providers/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { GET as listPaymentsRoute, POST as recordRoute } from "@/app/api/v1/finance/payments/route";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { ROLE_TEMPLATES } from "@/server/authz";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildFinanceWorld, idempotencyHeader, ledgerOf, makeJob, type FinanceWorld } from "./fixtures";

let w: FinanceWorld;
let other: FinanceWorld;
let jobA: { id: string; customerId: string };
let jobB: { id: string; customerId: string };
let paymentA: string;
let paymentB: string;

const record = (world: FinanceWorld, jobId: string, amountMinor: number) =>
  call(recordRoute, "POST", "/x", { cookie: world.cookie.finance, body: { jobId, method: "CASH", amountMinor }, headers: idempotencyHeader() });

beforeAll(async () => {
  w = await buildFinanceWorld("finance-access");
  other = await buildFinanceWorld("finance-other");
  jobA = await makeJob(w);
  jobB = await makeJob(w, { inCityB: true });
  paymentA = (await record(w, jobA.id, 1_000)).json.data.payment.id;
  paymentB = (await record(w, jobB.id, 2_000)).json.data.payment.id;
});
afterAll(disconnect);

describe("scope", () => {
  it("a City A manager sees City A money and gets an audited 404 for City B", async () => {
    expect((await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: jobA.id } })).status).toBe(200);
    const denied = await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: jobB.id } });
    expect(denied.status).toBe(404);
    const denials = await auditEvents(w.tenantId, "authz.denied");
    expect(denials.some((event) => event.correlationId === denied.correlationId)).toBe(true);

    const entries = (await call(listEntriesRoute, "GET", "/x", { cookie: w.cookie.cityManagerA })).json.data.map((e: { jobId: string }) => e.jobId);
    expect(entries).toContain(jobA.id);
    expect(entries).not.toContain(jobB.id);
    const payments = (await call(listPaymentsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA })).json.data.map((p: { id: string }) => p.id);
    expect(payments).toContain(paymentA);
    expect(payments).not.toContain(paymentB);
    const balances = (await call(jobBalancesRoute, "GET", "/x", { cookie: w.cookie.cityManagerA })).json.data.map((b: { jobId: string }) => b.jobId);
    expect(balances).toContain(jobA.id);
    expect(balances).not.toContain(jobB.id);

    const [entryB] = await ledgerOf(w, jobB.id);
    expect((await call(getEntryRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: entryB.id } })).status).toBe(404);
  });

  it("customer balances sum only in-scope entries; a customer with nothing visible is 404", async () => {
    expect((await call(customerBalanceRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: jobB.customerId } })).status).toBe(404);
    const own = await call(customerBalanceRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: jobA.customerId } });
    expect(own.json.data).toMatchObject({ coverage: "SCOPE", balances: [{ currency: "USD" }] });
    const all = await call(customerBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobB.customerId } });
    expect(all.json.data.coverage).toBe("TENANT");
  });

  it("a legal entity's totals need a TENANT or LEGAL_ENTITY scope, not a unit", async () => {
    const finance = await call(legalEntityBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: w.legalEntityId } });
    expect(finance.status).toBe(200);
    const usd = finance.json.data.balances.find((b: { currency: string }) => b.currency === "USD");
    expect(BigInt(usd.collectedMinor)).toBeGreaterThanOrEqual(3_000n);
    expect((await call(legalEntityBalanceRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: w.legalEntityId } })).status).toBe(404);
  });

  it("another tenant's records are not found", async () => {
    expect((await call(jobBalanceRoute, "GET", "/x", { cookie: other.cookie.finance, params: { id: jobA.id } })).status).toBe(404);
    expect((await call(voidRoute, "POST", "/x", { cookie: other.cookie.finance, params: { id: paymentA }, body: { reason: "x" } })).status).toBe(404);
    const recorded = await call(recordRoute, "POST", "/x", { cookie: other.cookie.finance, body: { jobId: jobA.id, method: "CASH", amountMinor: 1 }, headers: idempotencyHeader() });
    expect(recorded.status).toBe(404);
    expect(await ledgerOf(w, jobA.id)).toHaveLength(1);
  });
});

describe("permissions and field sets", () => {
  it("operational roles hold no finance access; COO and unit managers view but never move money", async () => {
    for (const cookie of [w.cookie.dispatcher, w.cookie.techA1, w.cookie.hr]) {
      expect((await call(jobBalanceRoute, "GET", "/x", { cookie, params: { id: jobA.id } })).status).toBe(403);
      expect((await call(listEntriesRoute, "GET", "/x", { cookie })).status).toBe(403);
    }
    expect((await call(jobBalanceRoute, "GET", "/x", { cookie: w.cooCookie, params: { id: jobA.id } })).status).toBe(200);
    for (const cookie of [w.cooCookie, w.cookie.cityManagerA]) {
      const response = await call(recordRoute, "POST", "/x", { cookie, body: { jobId: jobA.id, method: "CASH", amountMinor: 1 }, headers: idempotencyHeader() });
      expect(response.status).toBe(403);
      expect((await call(voidRoute, "POST", "/x", { cookie, params: { id: paymentA }, body: { reason: "x" } })).status).toBe(403);
    }
  });

  it("finance responses carry ids and money only, never the job's operational fields", async () => {
    const balance = (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobA.id } })).json.data;
    expect(Object.keys(balance).sort()).toEqual(["balances", "customerId", "jobId"]);
    const payment = (await call(listPaymentsRoute, "GET", "/x", { cookie: w.cookie.finance, query: { jobId: jobA.id } })).json.data[0];
    for (const field of ["title", "description", "instructions", "serviceAddressId", "tenantId", "idempotencyKey"]) expect(payment).not.toHaveProperty(field);
    // The Finance Director sees the job itself only through its financial field set.
    const job = (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobA.id } })).json.data;
    expect(job).not.toHaveProperty("title");
  });

  it("says truthfully that no payment provider is configured", async () => {
    const response = await call(paymentProvidersRoute, "GET", "/x", { cookie: w.cookie.finance });
    expect(response.json.data).toEqual({ configured: [] });
  });
});

describe("Finance has no dispatch rights (spec 26.3)", () => {
  it("the Finance Director template holds no dispatch, job edit/assign or employee edit permission", () => {
    const template = ROLE_TEMPLATES.find((t) => t.key === "FINANCE_DIRECTOR");
    const keys = (template?.grants ?? []).map((grant) => grant.permission);
    expect(keys.filter((key) => key.startsWith("dispatch.") || ["jobs.edit", "jobs.assign", "jobs.create", "employees.edit"].includes(key))).toEqual([]);
  });

  it("the Finance Director cannot assign, transition or dispatch a job", async () => {
    const assign = await call(assignRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: jobA.id }, body: { employeeId: w.techA1.employeeId } });
    expect(assign.status).toBe(403);
    const transition = await call(transitionRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: jobA.id }, body: { toStatus: "CANCELLED", reason: "x" } });
    expect(transition.status).toBe(403);
    expect((await call(candidatesRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobA.id } })).status).toBe(403);
  });

  it("recording money never changes the job's status", async () => {
    const before = (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobA.id } })).json.data.status;
    await call(recordRoute, "POST", "/x", { cookie: w.cookie.finance, body: { jobId: jobA.id, method: "CASH", amountMinor: 5 }, headers: { "idempotency-key": randomUUID() } });
    const after = (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobA.id } })).json.data.status;
    expect(after).toBe(before);
  });
});
