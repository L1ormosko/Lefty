import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/finance/reconciliation/exceptions/[id]/assign/route";
import { POST as resolveRoute } from "@/app/api/v1/finance/reconciliation/exceptions/[id]/resolve/route";
import { GET as getExceptionRoute } from "@/app/api/v1/finance/reconciliation/exceptions/[id]/route";
import { POST as unassignRoute } from "@/app/api/v1/finance/reconciliation/exceptions/[id]/unassign/route";
import { GET as listExceptionsRoute } from "@/app/api/v1/finance/reconciliation/exceptions/route";
import { GET as getRunRoute } from "@/app/api/v1/finance/reconciliation/runs/[id]/route";
import { GET as listRunsRoute } from "@/app/api/v1/finance/reconciliation/runs/route";
import { GET as summaryRoute } from "@/app/api/v1/finance/reconciliation/summary/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { POST as assignJobRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { ROLE_TEMPLATES } from "@/server/authz";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { buildFinanceWorld, ledgerOf, makeJob, storeSoldOutcome, type FinanceWorld } from "../finance/fixtures";
import { confirmCharge, exceptionsOfJob, recordPayment, startRun } from "./fixtures";

/**
 * World: City B is moved to a SECOND legal entity before any money is posted, so the ledger snapshots, the jobs' current
 * units and the exceptions all say "City A = entity 1, City B = entity 2".
 */
let w: FinanceWorld;
let other: FinanceWorld;
let secondEntityId: string;
let entityFinanceCookie: string;
let jobA: { jobId: string; outcomeId: string };
let jobB: { jobId: string; outcomeId: string };
let exceptionA: string;
let exceptionB: string;

async function partlyPaidJob(world: FinanceWorld, inCityB: boolean): Promise<{ jobId: string; outcomeId: string }> {
  const job = await makeJob(world, { inCityB });
  const outcomeId = await storeSoldOutcome(world, job.id, { charged: 10_000n });
  expect((await confirmCharge(world, outcomeId, 10_000)).status).toBe(201);
  await recordPayment(world, job.id, 3_000);
  return { jobId: job.id, outcomeId };
}

const assign = (id: string, assignedToId: string, cookie = w.cookie.finance) => call(assignRoute, "POST", "/x", { cookie, params: { id }, body: { assignedToId } });
const resolve = (id: string, body: Record<string, unknown>, cookie = w.cookie.finance) => call(resolveRoute, "POST", "/x", { cookie, params: { id }, body });
const getException = (id: string, cookie = w.cookie.finance) => call(getExceptionRoute, "GET", "/x", { cookie, params: { id } });
const listIds = async (cookie: string, query: Record<string, string> = {}) =>
  (await call(listExceptionsRoute, "GET", "/x", { cookie, query: { limit: "100", ...query } })).json.data.map((row: { id: string }) => row.id);

beforeAll(async () => {
  w = await buildFinanceWorld("recon-access");
  other = await buildFinanceWorld("recon-other");
  secondEntityId = await withTenant(w.tenantId, async (tx) => {
    const entity = await tx.legalEntity.create({ data: { tenantId: w.tenantId, name: "Second LE" } });
    await tx.orgUnit.update({ where: { id: w.units.cityB }, data: { legalEntityId: entity.id } });
    return entity.id;
  });
  const entityFinance = await createPerson(w.tenantId, "entity-finance", { withEmployee: false });
  await grantTemplate(w.tenantId, entityFinance, w.roles.FINANCE_DIRECTOR, [{ type: "LEGAL_ENTITY", legalEntityId: w.legalEntityId }]);
  entityFinanceCookie = await sessionCookie(entityFinance, w.tenantId);

  jobA = await partlyPaidJob(w, false);
  jobB = await partlyPaidJob(w, true);
  expect((await startRun(w, { legalEntityId: null })).status).toBe(201);
  exceptionA = (await exceptionsOfJob(w, jobA.jobId))[0].id as string;
  exceptionB = (await exceptionsOfJob(w, jobB.jobId))[0].id as string;
});
afterAll(disconnect);

describe("exception workflow: OPEN <-> ASSIGNED -> RESOLVED", () => {
  it("assigns only to someone who can resolve it, reassigns, unassigns, and resolves with resolver + reason", async () => {
    const ineligible = await assign(exceptionA, w.dispatcher.userId);
    expect(ineligible.status).toBe(400);
    expect(ineligible.json.error.details[0].code).toBe("reconciliation.assignee_not_eligible");
    expect((await assign(exceptionA, w.cityManagerA.userId)).status).toBe(400); // view-only template
    expect((await assign(exceptionA, other.finance.userId)).status).toBe(400); // another tenant's user does not exist here

    const assigned = await assign(exceptionA, w.finance.userId);
    expect(assigned.status).toBe(200);
    expect(assigned.json.data).toMatchObject({ replayed: false, exception: { status: "ASSIGNED", assignedToId: w.finance.userId } });
    expect((await assign(exceptionA, w.finance.userId)).json.data.replayed).toBe(true);
    expect(await listIds(w.cookie.finance, { assignedToId: "me" })).toEqual([exceptionA]);
    expect((await assign(exceptionA, w.ceo.userId)).json.data.exception.assignedToId).toBe(w.ceo.userId);

    const unassigned = await call(unassignRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: exceptionA }, body: { reason: "back to the pool" } });
    expect(unassigned.json.data.exception).toMatchObject({ status: "OPEN", assignedToId: null, assignedAt: null });

    expect((await resolve(exceptionA, {})).status).toBe(400);
    expect((await resolve(exceptionA, { reason: "   " })).status).toBe(400);
    const resolved = await resolve(exceptionA, { reason: "Customer paid by bank transfer; recorded separately" });
    expect(resolved.status).toBe(200);
    expect(resolved.json.data.exception).toMatchObject({ status: "RESOLVED", resolvedById: w.finance.userId, resolutionReason: "Customer paid by bank transfer; recorded separately" });
    expect((await resolve(exceptionA, { reason: "Customer paid by bank transfer; recorded separately" })).json.data.replayed).toBe(true);

    const again = await resolve(exceptionA, { reason: "another reason" });
    expect(again.status).toBe(409);
    expect(again.json.error.details[0].code).toBe("reconciliation.invalid_transition");
    expect((await assign(exceptionA, w.finance.userId)).status).toBe(409);

    for (const action of ["assign", "unassign", "resolve"]) {
      expect((await auditEvents(w.tenantId, `reconciliation_exception.${action}`, exceptionA)).length).toBeGreaterThanOrEqual(1);
    }
    const [resolveAudit] = await auditEvents(w.tenantId, "reconciliation_exception.resolve", exceptionA);
    expect(resolveAudit).toMatchObject({ actorUserId: w.finance.userId, reason: "Customer paid by bank transfer; recorded separately" });
  });

  it("what was found is frozen by the database", async () => {
    await expect(
      withTenant(w.tenantId, (tx) => tx.reconciliationException.update({ where: { id: exceptionB }, data: { expectedAmountMinor: 1n } })),
    ).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.reconciliationException.delete({ where: { id: exceptionB } }))).rejects.toThrow();
  });

  it("view-only and operational roles cannot assign or resolve", async () => {
    for (const cookie of [w.cookie.cityManagerB, w.cooCookie]) {
      expect((await assign(exceptionB, w.finance.userId, cookie)).status).toBe(403);
      expect((await resolve(exceptionB, { reason: "x" }, cookie)).status).toBe(403);
    }
    for (const cookie of [w.cookie.dispatcher, w.cookie.techB, w.cookie.hr]) {
      expect((await getException(exceptionB, cookie)).status).toBe(403);
      expect((await call(listExceptionsRoute, "GET", "/x", { cookie })).status).toBe(403);
    }
    expect((await getException(exceptionB)).json.data.status).toBe("OPEN");
  });
});

describe("scope by org unit and legal entity", () => {
  it("a city manager sees the exceptions of their unit only; another unit's is an audited 404", async () => {
    const seen = await listIds(w.cookie.cityManagerB);
    expect(seen).toContain(exceptionB);
    expect(seen).not.toContain(exceptionA);
    const denied = await getException(exceptionA, w.cookie.cityManagerB);
    expect(denied.status).toBe(404);
    expect((await auditEvents(w.tenantId, "authz.denied")).some((event) => event.correlationId === denied.correlationId)).toBe(true);
  });

  it("a city manager sees no runs (a legal entity's totals) and cannot start one", async () => {
    expect((await call(listRunsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA })).json.data).toEqual([]);
    const [run] = (await call(listRunsRoute, "GET", "/x", { cookie: w.cookie.finance })).json.data;
    expect((await call(getRunRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: run.id } })).status).toBe(404);
    expect((await startRun(w, {}, w.cookie.cityManagerA)).status).toBe(403);
    const summary = (await call(summaryRoute, "GET", "/x", { cookie: w.cookie.cityManagerB })).json.data;
    expect(summary).toMatchObject({ coverage: "SCOPE", latestRuns: [] });
    expect(summary.unresolved.PARTIAL_PAYMENT.open).toBe(1);
  });

  it("a legal-entity run examines that entity only; an entity-scoped finance user runs and reads only their entity", async () => {
    const own = await startRun(w, { legalEntityId: w.legalEntityId }, entityFinanceCookie);
    expect(own.status).toBe(201);
    expect((await startRun(w, { legalEntityId: secondEntityId }, entityFinanceCookie)).status).toBe(404);
    expect((await startRun(w, { legalEntityId: null }, entityFinanceCookie)).status).toBe(403);

    const runs = (await call(listRunsRoute, "GET", "/x", { cookie: entityFinanceCookie })).json.data;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((run: { legalEntityId: string }) => run.legalEntityId === w.legalEntityId)).toBe(true);
    expect(await listIds(entityFinanceCookie)).not.toContain(exceptionB);

    // A fresh City B problem is not found by entity 1's run, only by entity 2's.
    const late = await partlyPaidJob(w, true);
    await startRun(w, { legalEntityId: w.legalEntityId });
    expect(await exceptionsOfJob(w, late.jobId)).toEqual([]);
    await startRun(w, { legalEntityId: secondEntityId });
    expect(await exceptionsOfJob(w, late.jobId)).toHaveLength(1);
  });

  it("another tenant's records are not found", async () => {
    expect((await getException(exceptionB, other.cookie.finance)).status).toBe(404);
    expect((await startRun(other, { legalEntityId: w.legalEntityId })).status).toBe(404);
    expect(await listIds(other.cookie.finance)).not.toContain(exceptionB);
  });
});

describe("financial field sets", () => {
  it("outcome money in an exception needs the job_outcomes financial set; ledger gaps do not", async () => {
    const mismatch = await partlyPaidJob(w, false);
    await withTenant(w.tenantId, (tx) => tx.jobOutcome.update({ where: { id: mismatch.outcomeId }, data: { chargedAmountMinor: 9_000n } }));
    await startRun(w);
    const rows = await exceptionsOfJob(w, mismatch.jobId);
    const outcomeRow = rows.find((row) => row.kind === "OUTCOME_LEDGER_MISMATCH");
    expect(outcomeRow).toMatchObject({ moneyRedacted: false, expectedAmountMinor: "9000", recordedAmountMinor: "10000" });

    const roleId = await makeRole(w.tenantId, "Reconciliation clerk", [{ permission: "finance_reconciliation.view" }, { permission: "job_outcomes.view" }]);
    const clerk = await createPerson(w.tenantId, "recon-clerk", { withEmployee: false });
    await grantTemplate(w.tenantId, clerk, roleId, [{ type: "TENANT" }]);
    const clerkCookie = await sessionCookie(clerk, w.tenantId);
    const seen = await exceptionsOfJob(w, mismatch.jobId, clerkCookie);
    const redacted = seen.find((row) => row.kind === "OUTCOME_LEDGER_MISMATCH") as Record<string, unknown>;
    expect(redacted).toMatchObject({ moneyRedacted: true, expectedAmountMinor: null, recordedAmountMinor: null });
    expect(redacted.details).not.toHaveProperty("latestExpectedMinor");
    expect((await getException(redacted.id as string, clerkCookie)).json.data.moneyRedacted).toBe(true);
    expect(seen.find((row) => row.kind === "PARTIAL_PAYMENT")).toMatchObject({ moneyRedacted: false, expectedAmountMinor: "10000" });
  });

  it("responses carry ids and money only, never the job's operational fields", async () => {
    const exception = (await getException(exceptionB)).json.data;
    for (const field of ["title", "description", "serviceAddressId", "customerName", "tenantId"]) expect(exception).not.toHaveProperty(field);
  });
});

describe("Finance has no dispatch rights (spec 26.3)", () => {
  it("the reconciliation grants of the Finance Director add nothing operational", () => {
    const keys = (ROLE_TEMPLATES.find((t) => t.key === "FINANCE_DIRECTOR")?.grants ?? []).map((grant) => grant.permission);
    expect(keys.filter((key) => key.startsWith("finance_reconciliation."))).toEqual(
      expect.arrayContaining(["finance_reconciliation.view", "finance_reconciliation.create", "finance_reconciliation.edit", "finance_reconciliation.assign"]),
    );
    expect(keys.filter((key) => key.startsWith("dispatch.") || ["jobs.edit", "jobs.assign", "jobs.create", "employees.edit"].includes(key))).toEqual([]);
  });

  it("running and resolving change neither the job nor its money; Finance still cannot assign the job", async () => {
    const before = (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobB.jobId } })).json.data.status;
    const entriesBefore = (await ledgerOf(w, jobB.jobId)).length;
    await startRun(w, { legalEntityId: secondEntityId });
    await resolve(exceptionB, { reason: "Written off after review" });
    expect((await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobB.jobId } })).json.data.status).toBe(before);
    expect(await ledgerOf(w, jobB.jobId)).toHaveLength(entriesBefore);
    const assignJob = await call(assignJobRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: jobB.jobId }, body: { employeeId: w.techB.employeeId } });
    expect(assignJob.status).toBe(403);
  });
});
