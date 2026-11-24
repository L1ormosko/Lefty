import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignJobRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { POST as recordOutcomeRoute } from "@/app/api/v1/jobs/[id]/outcome/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { POST as createLostReasonRoute } from "@/app/api/v1/lost-reasons/route";
import { POST as activateRoute } from "@/app/api/v1/lead-recovery/rules/[id]/activate/route";
import { POST as dryRunRoute } from "@/app/api/v1/lead-recovery/rules/dry-run/route";
import { POST as submitRoute } from "@/app/api/v1/lead-recovery/rules/[id]/submit/route";
import { GET as getRuleRoute } from "@/app/api/v1/lead-recovery/rules/[id]/route";
import { GET as listRulesRoute, POST as createRuleRoute } from "@/app/api/v1/lead-recovery/rules/route";
import { POST as assignRoute } from "@/app/api/v1/lead-recovery/cases/[id]/assign/route";
import { POST as attemptRoute } from "@/app/api/v1/lead-recovery/cases/[id]/attempts/route";
import { POST as recoverRoute } from "@/app/api/v1/lead-recovery/cases/[id]/recover/route";
import { GET as getCaseRoute } from "@/app/api/v1/lead-recovery/cases/[id]/route";
import { GET as listCasesRoute } from "@/app/api/v1/lead-recovery/cases/route";
import { POST as statusRoute } from "@/app/api/v1/lead-recovery/cases/[id]/status/route";
import { GET as summaryRoute } from "@/app/api/v1/lead-recovery/summary/route";
import { GET as listFollowUpsRoute, POST as createFollowUpRoute } from "@/app/api/v1/follow-ups/route";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate, type Person } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

let w: JobsWorld;
let leadOps: Person;
let leadOpsCookie: string;
let reasonId: string;

beforeAll(async () => {
  w = await buildJobsWorld("recovery-routes");
  leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, leadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  leadOpsCookie = await sessionCookie(leadOps, w.tenantId);
  reasonId = (await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: "price-too-high", name: "Price too high" } })).json.data.id;
});
afterAll(disconnect);

/** A job taken to IN_PROGRESS by techA1, ready for an outcome. */
async function jobInProgress() {
  const job = await createJobViaApi(w, {});
  await call(assignJobRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  const start = Date.now() + 2 * 86_400_000;
  await call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: job.id },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
  for (const toStatus of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"]) {
    const response = await call(transitionRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { toStatus } });
    if (response.status !== 200) throw new Error(`setup ${toStatus}: ${response.status}`);
  }
  return job as { id: string };
}

describe("the full flow over HTTP: rule -> outcome -> case -> work -> recovery", () => {
  it("authoring, approval, automatic case creation inside the outcome transaction, assignment, attempts and recovery", async () => {
    // Lead Ops authors a high-impact rule; it cannot approve it; the Owner can.
    const rule = await call(createRuleRoute, "POST", "/x", {
      cookie: leadOpsCookie,
      body: { ruleKey: "lost-price", name: "Price objections", orgUnitId: w.units.cityA, conditions: { outcomes: ["NOT_SOLD"], lostReasonIds: [reasonId] }, actions: [{ type: "create_case", priority: "HIGH" }, { type: "recommend", code: "call_customer" }, { type: "notify", audience: "lead_operations" }] },
    });
    expect(rule.status).toBe(201);
    expect(rule.json.data).toMatchObject({ status: "DRAFT", highImpact: true, needsApproval: true });
    const ruleId = rule.json.data.id as string;
    expect((await call(submitRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: ruleId } })).status).toBe(200);
    expect((await call(activateRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: ruleId }, body: {} })).status).toBe(403);
    const approved = await call(activateRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { id: ruleId }, body: {} });
    expect(approved.status).toBe(200);
    expect(approved.json.data).toMatchObject({ status: "ACTIVE", approvedById: w.ceo.userId });

    // A technician records NOT_SOLD: the recovery case appears in the same transaction.
    const job = await jobInProgress();
    const recorded = await call(recordOutcomeRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { outcome: "NOT_SOLD", lostReasonId: reasonId, quotedAmountMinor: 120_000 } });
    expect(recorded.status).toBe(201);
    const list = await call(listCasesRoute, "GET", "/x", { cookie: leadOpsCookie, query: { jobId: job.id } });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    const caseRow = list.json.data[0];
    expect(caseRow).toMatchObject({ status: "NEW", jobId: job.id, priority: "HIGH", recommendation: "call_customer", presenceStatus: "UNKNOWN", ruleVersion: 1, estimatedValueMinor: 120_000 });

    // Lead Ops can open the original job (recovery_related set); a job without a case in the same unit stays closed to them.
    expect((await call(getJobRoute, "GET", "/x", { cookie: leadOpsCookie, params: { id: job.id } })).status).toBe(200);
    const other = await createJobViaApi(w, {});
    expect((await call(getJobRoute, "GET", "/x", { cookie: leadOpsCookie, params: { id: other.id } })).status).toBe(404);

    // A follow-up about that job: the list agrees with the single-record check (the job is open to Lead Ops only through its case).
    const jobTask = await call(createFollowUpRoute, "POST", "/x", { cookie: leadOpsCookie, body: { targetType: "JOB", targetId: job.id, title: "Job note", dueAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(jobTask.status).toBe(201);
    const listed = await call(listFollowUpsRoute, "GET", "/x", { cookie: leadOpsCookie });
    expect(listed.json.data.map((row: { id: string }) => row.id)).toContain(jobTask.json.data.id);

    // The follow-up module reaches the case through the recovery module's own access rules.
    const task = await call(createFollowUpRoute, "POST", "/x", { cookie: leadOpsCookie, body: { targetType: "RECOVERY_CASE", targetId: caseRow.id, title: "Call back", dueAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(task.status).toBe(201);
    expect(task.json.data).toMatchObject({ recoveryCaseId: caseRow.id, orgUnitId: w.units.cityA });
    expect((await call(createFollowUpRoute, "POST", "/x", { cookie: w.cookie.techA1, body: { targetType: "RECOVERY_CASE", targetId: caseRow.id, title: "Nope", dueAt: new Date(Date.now() + 3_600_000).toISOString() } })).status).toBeGreaterThanOrEqual(403);

    // Work the case.
    const caseId = caseRow.id as string;
    expect((await call(assignRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: caseId }, body: { assigneeId: w.cityManagerA.employeeId } })).json.data).toMatchObject({ status: "ASSIGNED" });
    const attempt = await call(attemptRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: caseId }, body: { channel: "PHONE", outcome: "REACHED" } });
    expect(attempt.status).toBe(201);
    expect((await call(statusRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: caseId }, body: { status: "CUSTOMER_REACHED" } })).status).toBe(200);
    const recovered = await call(recoverRoute, "POST", "/x", { cookie: leadOpsCookie, params: { id: caseId }, body: { recoveredAmountMinor: 100_000, collectedAmountMinor: 50_000 } });
    expect(recovered.status).toBe(200);
    expect(recovered.json.data).toMatchObject({ status: "RECOVERED", recoveredAmountMinor: 100_000, estimatedValueMinor: 120_000 });
    const detail = await call(getCaseRoute, "GET", "/x", { cookie: leadOpsCookie, params: { id: caseId } });
    expect(detail.json.data.statusHistory.map((entry: { toStatus: string }) => entry.toStatus).reverse()).toEqual(["NEW", "ASSIGNED", "CONTACTING", "CUSTOMER_REACHED", "RECOVERED"]);
    const summary = await call(summaryRoute, "GET", "/x", { cookie: leadOpsCookie });
    expect(summary.json.data.confirmed).toMatchObject([{ currency: "USD", recoveredAmountMinor: 100_000 }]);
  });

  it("a failing engine never blocks the technician's outcome: a corrupt stored rule is skipped", async () => {
    // Break a stored rule's JSON behind the service's back (DRAFT-guard does not apply to ACTIVE content writes, so use a fresh DRAFT then force status).
    await withTenant(w.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "RecoveryRule" (id, "tenantId", "ruleKey", version, name, status, priority, trigger, conditions, actions, "highImpact", "cooldownMinutes", "activatedAt", "updatedAt")
         VALUES ('corrupt-${w.tenantId}', '${w.tenantId}', 'corrupt', 1, 'Corrupt', 'ACTIVE', 1, 'job.not_converted', '{"unknownKey": true}'::jsonb, '[{"type":"apply_discount"}]'::jsonb, false, 0, now(), now())`,
      );
    });
    const job = await jobInProgress();
    const recorded = await call(recordOutcomeRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { outcome: "NOT_SOLD", lostReasonId: reasonId } });
    expect(recorded.status).toBe(201);
    await withTenant(w.tenantId, (tx) => tx.recoveryRule.update({ where: { id: `corrupt-${w.tenantId}` }, data: { status: "INACTIVE" } }));
  });
});

describe("access and validation at the HTTP boundary", () => {
  it("lists, reads and validates rules; technicians and dispatchers are refused", async () => {
    const rules = await call(listRulesRoute, "GET", "/x", { cookie: leadOpsCookie });
    expect(rules.status).toBe(200);
    expect((await call(listRulesRoute, "GET", "/x", { cookie: w.cookie.techA1 })).status).toBe(403);
    expect((await call(getRuleRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: "x" } })).status).toBe(403);
    const bad = await call(createRuleRoute, "POST", "/x", { cookie: leadOpsCookie, body: { ruleKey: "bad-one", name: "Bad", orgUnitId: w.units.cityA, actions: [{ type: "give_discount", percent: 20 }] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toMatch(/discount/i);
    const unknownKey = await call(createRuleRoute, "POST", "/x", { cookie: leadOpsCookie, body: { ruleKey: "bad-two", name: "Bad", orgUnitId: w.units.cityA, actions: [{ type: "create_case" }], surprise: 1 } });
    expect(unknownKey.status).toBe(400);
  });

  it("dry-run over HTTP writes nothing and answers with the explanation", async () => {
    const job = await jobInProgress();
    const recorded = await call(recordOutcomeRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { outcome: "NOT_SOLD", lostReasonId: reasonId, quotedAmountMinor: 5_000 } });
    const outcomeId = recorded.json.data.outcome.id as string;
    const before = await withTenant(w.tenantId, (tx) => tx.recoveryRuleRun.count({ where: { tenantId: w.tenantId } }));
    const result = await call(dryRunRoute, "POST", "/x", { cookie: leadOpsCookie, body: { jobOutcomeId: outcomeId, definition: { conditions: { minValueMinor: 1_000 }, actions: [{ type: "create_case" }] } } });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ matched: true, wouldFire: true, stored: false });
    expect(await withTenant(w.tenantId, (tx) => tx.recoveryRuleRun.count({ where: { tenantId: w.tenantId } }))).toBe(before);
    expect((await call(dryRunRoute, "POST", "/x", { cookie: w.cookie.techA1, body: { jobOutcomeId: outcomeId, definition: { actions: [{ type: "create_case" }] } } })).status).toBe(403);
  });
});
