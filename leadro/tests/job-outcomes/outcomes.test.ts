import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as eventsRoute } from "@/app/api/v1/jobs/[id]/events/route";
import { GET as historyRoute } from "@/app/api/v1/jobs/[id]/history/route";
import { POST as recordRoute } from "@/app/api/v1/jobs/[id]/outcome/route";
import { GET as jobOutcomesRoute } from "@/app/api/v1/jobs/[id]/outcomes/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { PUT as workflowPut } from "@/app/api/v1/jobs/workflow-settings/route";
import { GET as correctionsRoute } from "@/app/api/v1/job-outcomes/[id]/corrections/route";
import { GET as getOutcomeRoute, PATCH as patchOutcomeRoute } from "@/app/api/v1/job-outcomes/[id]/route";
import { GET as listOutcomesRoute } from "@/app/api/v1/job-outcomes/route";
import { GET as getLostReasonRoute, PATCH as patchLostReasonRoute } from "@/app/api/v1/lost-reasons/[id]/route";
import { GET as listLostReasonsRoute, POST as createLostReasonRoute } from "@/app/api/v1/lost-reasons/route";
import { withTenant } from "@/server/db";
import { onJobOutcomeRecorded, outcomeResourceRef, resetJobOutcomeHandlers } from "@/server/job-outcomes";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: JobsWorld;
let reasons: { price: string; noNeed: string; outsideScope: string; inactive: string };

beforeAll(async () => {
  w = await buildJobsWorld("job-outcomes");
  const create = async (body: Record<string, unknown>) => (await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body })).json.data.id as string;
  reasons = {
    price: await create({ code: "price-too-high", name: "Price too high" }),
    noNeed: await create({ code: "no-longer-needed", name: "No longer needed", appliesTo: ["NOT_SOLD"] }),
    outsideScope: await create({ code: "outside-scope", name: "Outside our services", appliesTo: ["WORK_NOT_POSSIBLE"], recoverable: false }),
    inactive: await create({ code: "retired", name: "Retired reason" }),
  };
  await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: reasons.inactive }, body: { active: false } });
});
afterAll(disconnect);
afterEach(resetJobOutcomeHandlers);

const move = (cookie: string, jobId: string, toStatus: string, reason?: string) =>
  call(transitionRoute, "POST", "/x", { cookie, params: { id: jobId }, body: reason === undefined ? { toStatus } : { toStatus, reason } });
const record = (cookie: string, jobId: string, body: Record<string, unknown>) => call(recordRoute, "POST", "/x", { cookie, params: { id: jobId }, body });
const getJob = async (jobId: string) => (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobId } })).json.data;

/** A job assigned to techA1 and taken to `upTo` (EN_ROUTE, ARRIVED or IN_PROGRESS). */
async function jobAt(upTo: "EN_ROUTE" | "ARRIVED" | "IN_PROGRESS", body: Record<string, unknown> = {}) {
  const job = await createJobViaApi(w, body);
  await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  const start = Date.now() + 2 * 86_400_000;
  await call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: job.id },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
  const path = ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"];
  for (const status of path.slice(0, path.indexOf(upTo) + 1)) {
    const response = await move(w.cookie.dispatcher, job.id, status);
    if (response.status !== 200) throw new Error(`setup: ${status} -> ${response.status} ${JSON.stringify(response.json)}`);
  }
  return job;
}

const notificationsOf = (userId: string, eventType: string) =>
  withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: userId, eventType }, orderBy: { createdAt: "asc" } }));

describe("recording an outcome moves the job through its lifecycle", () => {
  it("SOLD completes the job, stores the amounts in minor units and leaves the full trail", async () => {
    const job = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, job.id, {
      outcome: "SOLD",
      notes: "Replaced the capacitor",
      quotedAmountMinor: 45000,
      approvedAmountMinor: 45000,
      chargedAmountMinor: 45000,
      collectedAmountMinor: 20000,
      paymentMethod: "CARD",
      paymentStatus: "PARTIAL",
    });
    expect(response.status).toBe(201);
    expect(response.json.data.job).toMatchObject({ id: job.id, status: "COMPLETED", currentVisitNumber: 1 });
    expect(response.json.data.outcome).toMatchObject({
      jobId: job.id,
      visitNumber: 1,
      outcome: "SOLD",
      lostReasonId: null,
      chargedAmountMinor: 45000,
      collectedAmountMinor: 20000,
      paymentStatus: "PARTIAL",
      paymentMethod: "CARD",
      employeeId: w.techA1.employeeId,
    });
    expect(response.json.data.outcome.currency).toBe("USD");

    const history = await call(historyRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, query: { limit: "50" } });
    expect(history.json.data[0]).toMatchObject({ toStatus: "COMPLETED", reason: "Outcome SOLD" });
    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, query: { limit: "50" } });
    const recorded = events.json.data.find((row: { type: string }) => row.type === "job.outcome_recorded");
    expect(recorded.payload).toMatchObject({ outcomeId: response.json.data.outcome.id, outcome: "SOLD", visitNumber: 1, toStatus: "COMPLETED" });
    expect(JSON.stringify(recorded.payload)).not.toContain("Replaced"); // free text and money stay out of events
    expect(events.json.data.some((row: { type: string }) => row.type === "job.not_converted")).toBe(false);

    const audit = (await auditEvents(w.tenantId, "job_outcome.record", response.json.data.outcome.id))[0];
    expect(audit.newValue).toMatchObject({ outcome: "SOLD", moneyFields: ["quotedAmountMinor", "approvedAmountMinor", "chargedAmountMinor", "collectedAmountMinor"] });
    expect(JSON.stringify(audit.newValue)).not.toContain("45000");
  });

  it("maps every other outcome to its job status", async () => {
    const cases: Array<[string, "EN_ROUTE" | "ARRIVED" | "IN_PROGRESS", Record<string, unknown>, string]> = [
      ["NOT_SOLD", "IN_PROGRESS", { lostReasonId: reasons.price, quotedAmountMinor: 90000 }, "COMPLETED"],
      ["ADDITIONAL_APPROVAL_REQUIRED", "IN_PROGRESS", {}, "REQUIRES_RETURN_VISIT"],
      ["WORK_NOT_POSSIBLE", "ARRIVED", { lostReasonId: reasons.outsideScope }, "FAILED"],
      ["CUSTOMER_UNAVAILABLE", "EN_ROUTE", {}, "CUSTOMER_UNAVAILABLE"],
      ["RESCHEDULE_REQUIRED", "ARRIVED", {}, "RESCHEDULED"],
    ];
    for (const [outcome, upTo, extra, expectedStatus] of cases) {
      const job = await jobAt(upTo);
      const response = await record(w.cookie.techA1, job.id, { outcome, ...extra });
      expect(response.status, `${outcome}: ${JSON.stringify(response.json)}`).toBe(201);
      expect(response.json.data.job.status, outcome).toBe(expectedStatus);
    }
  });

  it("refuses an outcome the job's current step does not allow, and writes nothing", async () => {
    const job = await jobAt("ARRIVED");
    const response = await record(w.cookie.techA1, job.id, { outcome: "SOLD" }); // work has not started
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("job_outcome.not_reportable");
    expect((await getJob(job.id)).status).toBe("ARRIVED");
    const stored = await withTenant(w.tenantId, (tx) => tx.jobOutcome.count({ where: { jobId: job.id } }));
    expect(stored).toBe(0);
  });

  it("allows one outcome per visit", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).status).toBe(201);
    const again = await record(w.cookie.techA1, job.id, { outcome: "SOLD" });
    expect(again.status).toBe(409);
    expect(again.json.error.details[0].code).toBe("job_outcome.already_recorded");
  });
});

describe("§9.1 reasons and amounts", () => {
  it("requires a lost reason for NOT_SOLD and WORK_NOT_POSSIBLE", async () => {
    const job = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD" });
    expect(response.status).toBe(400);
    expect(response.json.error.details[0]).toMatchObject({ field: "lostReasonId", code: "job_outcome.lost_reason_required" });
    expect((await getJob(job.id)).status).toBe("IN_PROGRESS");
  });

  it("refuses a reason on a sale, an unknown / inactive reason, and one that does not apply to the outcome", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", lostReasonId: reasons.price })).json.error.details[0].code).toBe("job_outcome.lost_reason_not_allowed");
    expect((await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.inactive })).json.error.details[0].code).toBe("job_outcome.lost_reason_unknown");
    expect((await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: "no-such-reason" })).json.error.details[0].code).toBe("job_outcome.lost_reason_unknown");
    expect((await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.outsideScope })).json.error.details[0].code).toBe("job_outcome.lost_reason_not_applicable");
    expect((await getJob(job.id)).status).toBe("IN_PROGRESS");
  });

  it("keeps sale money and payment to sales, whole minor units, and a payment that was collected needs its amount", async () => {
    const job = await jobAt("IN_PROGRESS");
    const notSold = (extra: Record<string, unknown>) => record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.price, ...extra });
    expect((await notSold({ chargedAmountMinor: 100 })).json.error.details[0].code).toBe("job_outcome.amounts_not_applicable");
    expect((await notSold({ paymentStatus: "PAID" })).json.error.details[0].code).toBe("job_outcome.payment_not_applicable");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", quotedAmountMinor: 12.5 })).status).toBe(400); // no floats
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", quotedAmountMinor: -1 })).status).toBe(400);
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", paymentStatus: "PAID" })).json.error.details[0].code).toBe("job_outcome.payment_needs_collected_amount");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", currency: "usd", quotedAmountMinor: 100 })).json.data.outcome.currency).toBe("USD");
  });

  it("refuses a time in the future", async () => {
    const job = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, job.id, { outcome: "SOLD", occurredAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(response.status).toBe(400);
    expect(response.json.error.details[0].code).toBe("job_outcome.occurred_in_future");
  });
});

describe("a job cannot close without an outcome (§9.1)", () => {
  it("blocks CLOSED until the current visit has an outcome", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await move(w.cookie.dispatcher, job.id, "COMPLETED")).status).toBe(200);
    const blocked = await move(w.cookie.dispatcher, job.id, "CLOSED");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details[0].code).toBe("job.outcome_required");
    expect((await getJob(job.id)).status).toBe("COMPLETED");

    // A SOLD outcome cannot be recorded on a COMPLETED job (the visit is over): the manager path is a DB-level record in tests,
    // in production the technician reports it while the work is IN_PROGRESS. Here: use a job that was reported properly.
    const reported = await jobAt("IN_PROGRESS");
    await record(w.cookie.techA1, reported.id, { outcome: "SOLD" });
    expect((await move(w.cookie.dispatcher, reported.id, "CLOSED")).json.data.status).toBe("CLOSED");
  });

  it("lets a failed visit close once its outcome was recorded", async () => {
    const job = await jobAt("ARRIVED");
    await record(w.cookie.techA1, job.id, { outcome: "WORK_NOT_POSSIBLE", lostReasonId: reasons.outsideScope });
    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).json.data.status).toBe("CLOSED");
  });
});

describe("later visits", () => {
  const scheduleAgain = (jobId: string, daysAhead = 5) => {
    const start = Date.now() + daysAhead * 86_400_000;
    return call(rescheduleRoute, "POST", "/x", {
      cookie: w.cookie.dispatcher,
      params: { id: jobId },
      body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() } },
    });
  };

  it("starts visit 2 when the technician is on the way again, and takes a second outcome", async () => {
    const job = await jobAt("EN_ROUTE");
    const first = await record(w.cookie.techA1, job.id, { outcome: "CUSTOMER_UNAVAILABLE", notes: "Nobody home" });
    expect(first.json.data.job).toMatchObject({ status: "CUSTOMER_UNAVAILABLE", currentVisitNumber: 1 });
    expect((await move(w.cookie.dispatcher, job.id, "RESCHEDULED", "Customer asked for next week")).status).toBe(200);
    expect((await scheduleAgain(job.id)).json.data.status).toBe("SCHEDULED");
    expect((await getJob(job.id)).currentVisitNumber).toBe(1); // still waiting: the visit has not started

    expect((await move(w.cookie.dispatcher, job.id, "EN_ROUTE")).status).toBe(200);
    expect((await getJob(job.id)).currentVisitNumber).toBe(2);
    for (const status of ["ARRIVED", "IN_PROGRESS"]) await move(w.cookie.dispatcher, job.id, status);
    expect((await getJob(job.id)).currentVisitNumber).toBe(2); // moving on inside the visit never advances it again
    const second = await record(w.cookie.techA1, job.id, { outcome: "SOLD" });
    expect(second.status).toBe(201);
    expect(second.json.data.outcome.visitNumber).toBe(2);

    const list = await call(jobOutcomesRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(list.json.data.map((row: { visitNumber: number }) => row.visitNumber)).toEqual([2, 1]);
  });

  it("counts the next visit across a hold and a trip back to the pool (RESCHEDULE_REQUIRED > ON_HOLD > PENDING_ASSIGNMENT > ... > visit 2)", async () => {
    const job = await jobAt("ARRIVED");
    expect((await record(w.cookie.techA1, job.id, { outcome: "RESCHEDULE_REQUIRED" })).json.data.job.status).toBe("RESCHEDULED");
    expect((await move(w.cookie.dispatcher, job.id, "ON_HOLD", "Waiting for the customer")).status).toBe(200);
    expect((await move(w.cookie.dispatcher, job.id, "PENDING_ASSIGNMENT")).status).toBe(200);
    expect((await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } })).status).toBe(200);
    expect((await scheduleAgain(job.id)).json.data.status).toBe("SCHEDULED");
    expect((await getJob(job.id)).currentVisitNumber).toBe(1);
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"]) expect((await move(w.cookie.dispatcher, job.id, status)).status).toBe(200);
    expect((await getJob(job.id)).currentVisitNumber).toBe(2);
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).json.data.outcome.visitNumber).toBe(2);
  });

  it("does not advance while the current visit has no outcome (wrong job started, then back on the way)", async () => {
    const job = await jobAt("EN_ROUTE");
    expect((await move(w.cookie.dispatcher, job.id, "SCHEDULED")).status).toBe(200); // started the wrong job
    expect((await move(w.cookie.dispatcher, job.id, "EN_ROUTE")).status).toBe(200);
    expect((await getJob(job.id)).currentVisitNumber).toBe(1);
  });

  it("does not open a new visit when a reviewer sends finished work back", async () => {
    const job = await jobAt("IN_PROGRESS", { jobTypeId: w.ids.reviewType });
    await record(w.cookie.techA1, job.id, { outcome: "SOLD" });
    expect((await move(w.cookie.dispatcher, job.id, "AWAITING_REVIEW")).status).toBe(200);
    expect((await move(w.cookie.ceo, job.id, "IN_PROGRESS")).status).toBe(200);
    expect((await getJob(job.id)).currentVisitNumber).toBe(1);
  });
});

describe("retroactive outcomes for jobs already past their visit", () => {
  it.each(["COMPLETED", "FAILED", "REQUIRES_RETURN_VISIT"])("lets a manager record the missing outcome of a hand-%s job, then the job closes", async (status) => {
    const job = await jobAt("IN_PROGRESS");
    expect((await move(w.cookie.dispatcher, job.id, status, status === "COMPLETED" ? undefined : "Moved by hand")).status).toBe(200);
    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).json.error.details[0].code).toBe("job.outcome_required");

    const body = status === "FAILED" ? { outcome: "WORK_NOT_POSSIBLE", lostReasonId: reasons.outsideScope } : status === "COMPLETED" ? { outcome: "SOLD", chargedAmountMinor: 100 } : { outcome: "ADDITIONAL_APPROVAL_REQUIRED" };
    const recorded = await record(w.cookie.cityManagerA, job.id, body);
    expect(recorded.status).toBe(201);
    expect(recorded.json.data.job.status).toBe(status); // no status change
    const outcomeId = recorded.json.data.outcome.id;
    const audit = (await auditEvents(w.tenantId, "job_outcome.record", outcomeId))[0];
    expect(audit.newValue).toMatchObject({ retroactive: true });
    expect(audit.reason).toMatch(/Retroactive/);
    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, query: { limit: "50" } });
    expect(events.json.data.find((row: { type: string }) => row.type === "job.outcome_recorded").payload).toMatchObject({ retroactive: true, fromStatus: status, toStatus: status });

    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).json.data.status).toBe("CLOSED");
  });

  it("lets a manager record it for a job awaiting review and for a customer-unavailable job", async () => {
    const review = await jobAt("IN_PROGRESS", { jobTypeId: w.ids.reviewType });
    await move(w.cookie.dispatcher, review.id, "COMPLETED");
    await move(w.cookie.dispatcher, review.id, "AWAITING_REVIEW");
    expect((await record(w.cookie.cityManagerA, review.id, { outcome: "SOLD" })).status).toBe(201);
    expect((await move(w.cookie.ceo, review.id, "CLOSED")).json.data.status).toBe("CLOSED");

    const away = await jobAt("EN_ROUTE");
    await move(w.cookie.dispatcher, away.id, "CUSTOMER_UNAVAILABLE", "Nobody home");
    expect((await record(w.cookie.cityManagerA, away.id, { outcome: "CUSTOMER_UNAVAILABLE" })).json.data.job.status).toBe("CUSTOMER_UNAVAILABLE");
  });

  it("keeps live visits to the technician and refuses anyone without create or edit; a second outcome for the visit is still a 409", async () => {
    const live = await jobAt("IN_PROGRESS");
    expect((await record(w.cookie.cityManagerA, live.id, { outcome: "SOLD" })).status).toBe(403); // edit-only: not their visit to report
    expect((await getJob(live.id)).status).toBe("IN_PROGRESS");

    const done = await jobAt("IN_PROGRESS");
    await move(w.cookie.dispatcher, done.id, "COMPLETED");
    expect((await record(w.cookie.dispatcher, done.id, { outcome: "SOLD" })).status).toBe(403); // view only
    expect((await record(w.cookie.cityManagerB, done.id, { outcome: "SOLD" })).status).toBe(404); // other city
    expect((await record(w.cookie.cityManagerA, done.id, { outcome: "SOLD" })).status).toBe(201);
    expect((await record(w.cookie.cityManagerA, done.id, { outcome: "NOT_SOLD", lostReasonId: reasons.price })).status).toBe(409);
  });
});

describe("offline replay (§8.7, §25.3)", () => {
  it("returns the first result for the same clientEventId and content, and stores nothing twice", async () => {
    const job = await jobAt("IN_PROGRESS");
    const clientEventId = randomUUID();
    const occurredAt = new Date(Date.now() + 1_000).toISOString();
    const body = { outcome: "SOLD", chargedAmountMinor: 5000, clientEventId, occurredAt };
    const first = await record(w.cookie.techA1, job.id, body);
    const second = await record(w.cookie.techA1, job.id, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.data.replayed).toBe(true);
    expect(second.json.data.outcome.id).toBe(first.json.data.outcome.id);
    expect(second.json.data.outcome.occurredAt).toBe(occurredAt);

    const counts = await withTenant(w.tenantId, async (tx) => ({
      outcomes: await tx.jobOutcome.count({ where: { jobId: job.id } }),
      fieldEvents: await tx.fieldEvent.count({ where: { clientEventId } }),
      jobEvents: await tx.jobEvent.count({ where: { jobId: job.id, type: "job.outcome_recorded" } }),
    }));
    expect(counts).toEqual({ outcomes: 1, fieldEvents: 1, jobEvents: 1 });
  });

  it("answers 409 when the same clientEventId comes back with different content", async () => {
    const job = await jobAt("IN_PROGRESS");
    const clientEventId = randomUUID();
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", chargedAmountMinor: 5000, clientEventId })).status).toBe(201);
    const conflict = await record(w.cookie.techA1, job.id, { outcome: "SOLD", chargedAmountMinor: 9999, clientEventId });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.details[0].code).toBe("field_event.payload_mismatch");
  });

  it("rejects a clientEventId that is not a UUID", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD", clientEventId: "not-a-uuid" })).status).toBe(400);
  });
});

describe("who may report, read and correct", () => {
  it("lets only an assigned technician report: another technician gets 404, a view-only role 403", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await record(w.cookie.techB, job.id, { outcome: "SOLD" })).status).toBe(404); // not their job
    expect((await record(w.cookie.dispatcher, job.id, { outcome: "SOLD" })).status).toBe(403); // job_outcomes.view only, no create
    expect((await getJob(job.id)).status).toBe("IN_PROGRESS");
    expect((await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).status).toBe(201);
  });

  it("scopes reads: the technician sees only their jobs' outcomes, a manager of the unit sees them, another city does not", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).json.data.outcome.id;
    expect((await call(getOutcomeRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: outcomeId } })).status).toBe(200);
    expect((await call(getOutcomeRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: outcomeId } })).status).toBe(200);
    expect((await call(getOutcomeRoute, "GET", "/x", { cookie: w.cookie.techB, params: { id: outcomeId } })).status).toBe(404);
    expect((await call(getOutcomeRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { id: outcomeId } })).status).toBe(404);

    const mine = await call(listOutcomesRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { jobId: job.id } });
    expect(mine.json.data.map((row: { id: string }) => row.id)).toEqual([outcomeId]);
    const others = await call(listOutcomesRoute, "GET", "/x", { cookie: w.cookie.techB });
    expect(others.json.data.every((row: { jobId: string }) => row.jobId !== job.id)).toBe(true);
    const managerB = await call(listOutcomesRoute, "GET", "/x", { cookie: w.cookie.cityManagerB });
    expect(managerB.json.data.some((row: { id: string }) => row.id === outcomeId)).toBe(false);
    const filtered = await call(listOutcomesRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { outcome: "SOLD", jobId: job.id } });
    expect(filtered.json.data).toHaveLength(1);
  });

  it("lets a manager correct amounts and reason with a correction reason, audited by field name; technicians cannot", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.price, quotedAmountMinor: 80000 })).json.data.outcome.id;
    const patch = (cookie: string, body: Record<string, unknown>) => call(patchOutcomeRoute, "PATCH", "/x", { cookie, params: { id: outcomeId }, body });

    expect((await patch(w.cookie.techA1, { reason: "Typo", quotedAmountMinor: 8000 })).status).toBe(403); // reporting is not correcting
    expect((await patch(w.cookie.cityManagerA, { quotedAmountMinor: 8000 })).status).toBe(400); // a reason is required
    expect((await patch(w.cookie.cityManagerA, { reason: "Typo", lostReasonId: null })).json.error.details[0].code).toBe("job_outcome.lost_reason_required");
    expect((await patch(w.cookie.cityManagerA, { reason: "Wrong job", chargedAmountMinor: 5 })).json.error.details[0].code).toBe("job_outcome.amounts_not_applicable");

    const fixed = await patch(w.cookie.cityManagerA, { reason: "Typo in the quote", quotedAmountMinor: 8000, lostReasonId: reasons.noNeed });
    expect(fixed.status).toBe(200);
    expect(fixed.json.data).toMatchObject({ quotedAmountMinor: 8000, lostReasonId: reasons.noNeed, outcome: "NOT_SOLD" });
    const audit = (await auditEvents(w.tenantId, "job_outcome.correct", outcomeId))[0];
    expect(audit.reason).toBe("Typo in the quote");
    expect(audit.newValue).toMatchObject({ changedFields: ["lostReasonId", "quotedAmountMinor"] });
    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(events.json.data.map((row: { type: string }) => row.type)).toContain("job.outcome_corrected");
  });

  it("never shows an outcome of another tenant", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).json.data.outcome.id;
    const other: World = await buildWorld("job-outcomes-other");
    const otherCeo = await sessionCookie(other.ceo, other.tenantId);
    expect((await call(getOutcomeRoute, "GET", "/x", { cookie: otherCeo, params: { id: outcomeId } })).status).toBe(404);
    expect((await call(getLostReasonRoute, "GET", "/x", { cookie: otherCeo, params: { id: reasons.price } })).status).toBe(404);
    const list = await call(listLostReasonsRoute, "GET", "/x", { cookie: otherCeo, query: { includeInactive: "true" } });
    expect(list.json.data.some((row: { id: string }) => Object.values(reasons).includes(row.id))).toBe(false);
  });
});

describe("recovery hooks and notifications", () => {
  it("writes job.not_converted, tells the managers of the unit (not the reporter) and links to the outcome", async () => {
    const job = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.price, customerRequestedFollowUp: true });
    const outcomeId = response.json.data.outcome.id;

    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, query: { limit: "50" } });
    const notConverted = events.json.data.find((row: { type: string }) => row.type === "job.not_converted");
    expect(notConverted.payload).toEqual({ outcomeId, outcome: "NOT_SOLD", lostReasonId: reasons.price, recoverable: true });
    const recorded = events.json.data.find((row: { type: string }) => row.type === "job.outcome_recorded");
    expect(recorded.payload.customerRequestedFollowUp).toBe(true);

    const toManager = (await notificationsOf(w.cityManagerA.userId, "job.not_converted")).filter((row) => row.targetId === outcomeId);
    expect(toManager).toHaveLength(1);
    expect(toManager[0]).toMatchObject({ targetType: "job_outcome", params: { jobNumber: job.number } });
    expect((await notificationsOf(w.techA1.userId, "job.not_converted")).filter((row) => row.targetId === outcomeId)).toHaveLength(0);
    expect((await notificationsOf(w.cityManagerB.userId, "job.not_converted")).filter((row) => row.targetId === outcomeId)).toHaveLength(0);
  });

  it("does not raise job.not_converted for a sale", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).json.data.outcome.id;
    expect((await notificationsOf(w.cityManagerA.userId, "job.not_converted")).filter((row) => row.targetId === outcomeId)).toHaveLength(0);
  });

  it("publishes the domain event to subscribers inside the transaction; a failing subscriber rolls the outcome back", async () => {
    const seen: Array<{ outcome: string; notConverted: boolean; jobStatus: string; lostReasonRecoverable: boolean | null }> = [];
    onJobOutcomeRecorded("test-subscriber", async (tx, event) => {
      const row = await tx.jobOutcome.findFirst({ where: { id: event.outcomeId, tenantId: event.tenantId }, select: { id: true } });
      expect(row).not.toBeNull(); // the outcome is already visible to the subscriber's transaction
      seen.push({ outcome: event.outcome, notConverted: event.notConverted, jobStatus: event.jobStatus, lostReasonRecoverable: event.lostReasonRecoverable });
    });
    const job = await jobAt("IN_PROGRESS");
    await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.price });
    expect(seen).toEqual([{ outcome: "NOT_SOLD", notConverted: true, jobStatus: "COMPLETED", lostReasonRecoverable: true }]);

    onJobOutcomeRecorded("test-subscriber", async () => {
      throw new Error("recovery engine failed");
    });
    const failing = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, failing.id, { outcome: "SOLD" });
    expect(response.status).toBe(500);
    expect((await getJob(failing.id)).status).toBe("IN_PROGRESS");
    expect(await withTenant(w.tenantId, (tx) => tx.jobOutcome.count({ where: { jobId: failing.id } }))).toBe(0);
  });

  it("authorizes outcome links through the job (resolver used by the notifications read-time check)", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "SOLD" })).json.data.outcome.id;
    const ref = await withTenant(w.tenantId, (tx) => outcomeResourceRef(tx, w.tenantId, outcomeId));
    expect(ref).toMatchObject({ orgUnitId: expect.any(String), assignedEmployeeIds: [w.techA1.employeeId] }); // still assigned until the job closes
    expect(await withTenant(w.tenantId, (tx) => outcomeResourceRef(tx, w.tenantId, "missing"))).toBeNull();
  });
});

describe("tenant narrowing still applies", () => {
  it("refuses an outcome whose job edge the company switched off, writing nothing", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await call(workflowPut, "PUT", "/x", { cookie: w.cookie.ceo, body: { disabledTransitions: ["IN_PROGRESS>REQUIRES_RETURN_VISIT"] } })).status).toBe(200);
    try {
      const response = await record(w.cookie.techA1, job.id, { outcome: "ADDITIONAL_APPROVAL_REQUIRED" });
      expect(response.status).toBe(409);
      expect(await withTenant(w.tenantId, (tx) => tx.jobOutcome.count({ where: { jobId: job.id } }))).toBe(0);
      expect((await getJob(job.id)).status).toBe("IN_PROGRESS");
    } finally {
      await call(workflowPut, "PUT", "/x", { cookie: w.cookie.ceo, body: { disabledTransitions: [] } });
    }
  });
});

describe("lost reasons admin (§9.2)", () => {
  it("lists active reasons in display order to technicians, filtered by outcome, and hides retired ones", async () => {
    const list = await call(listLostReasonsRoute, "GET", "/x", { cookie: w.cookie.techA1 });
    expect(list.status).toBe(200);
    const codes = list.json.data.map((row: { code: string }) => row.code);
    expect(codes).toContain("price-too-high");
    expect(codes).not.toContain("retired");
    const forWorkNotPossible = await call(listLostReasonsRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { outcome: "WORK_NOT_POSSIBLE" } });
    expect(forWorkNotPossible.json.data.map((row: { code: string }) => row.code)).toContain("outside-scope");
    expect(forWorkNotPossible.json.data.map((row: { code: string }) => row.code)).not.toContain("no-longer-needed");
    const all = await call(listLostReasonsRoute, "GET", "/x", { cookie: w.cookie.ceo, query: { includeInactive: "true" } });
    expect(all.json.data.map((row: { code: string }) => row.code)).toContain("retired");
  });

  it("is configured only with job_outcomes.configure: technicians and managers get 403", async () => {
    const body = { code: "x-reason", name: "X" };
    expect((await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.techA1, body })).status).toBe(403);
    expect((await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.cityManagerA, body })).status).toBe(403);
    expect((await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.techA1, params: { id: reasons.price }, body: { name: "Hacked" } })).status).toBe(403);
  });

  it("keeps codes unique per tenant, validates them, never changes them, and audits changes", async () => {
    expect((await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: "price-too-high", name: "Dup" } })).status).toBe(409);
    expect((await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: "Bad Code!", name: "Bad" } })).status).toBe(400);
    expect((await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: "empty-applies", name: "E", appliesTo: [] } })).status).toBe(400);
    expect((await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: reasons.price }, body: { code: "renamed" } })).status).toBe(400);

    const created = await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: "competitor", name: "Chose a competitor", sortOrder: 5 } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ code: "competitor", appliesTo: ["NOT_SOLD", "WORK_NOT_POSSIBLE"], recoverable: true, active: true, sortOrder: 5 });
    const updated = await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: created.json.data.id }, body: { recoverable: false, name: "Chose another company" } });
    expect(updated.json.data).toMatchObject({ name: "Chose another company", recoverable: false });
    expect((await auditEvents(w.tenantId, "lost_reason.create", created.json.data.id))).toHaveLength(1);
    expect((await auditEvents(w.tenantId, "lost_reason.update", created.json.data.id))).toHaveLength(1);
  });

  it("keeps a retired reason on the outcomes that used it", async () => {
    const job = await jobAt("IN_PROGRESS");
    const outcomeId = (await record(w.cookie.techA1, job.id, { outcome: "NOT_SOLD", lostReasonId: reasons.noNeed })).json.data.outcome.id;
    await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: reasons.noNeed }, body: { active: false } });
    const outcome = await call(getOutcomeRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id: outcomeId } });
    expect(outcome.json.data.lostReasonId).toBe(reasons.noNeed);
    await call(patchLostReasonRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: reasons.noNeed }, body: { active: true } });
  });
});

describe("fix round 1: money, corrections, currency, idempotency details", () => {
  const getOutcome = (cookie: string, outcomeId: string) => call(getOutcomeRoute, "GET", "/x", { cookie, params: { id: outcomeId } });
  const patchOutcome = (cookie: string, outcomeId: string, body: Record<string, unknown>) => call(patchOutcomeRoute, "PATCH", "/x", { cookie, params: { id: outcomeId }, body });

  it("shows amounts and payment only with the financial set: Dispatcher sees the outcome, not the money", async () => {
    const job = await jobAt("IN_PROGRESS");
    const recorded = await record(w.cookie.techA1, job.id, { outcome: "SOLD", chargedAmountMinor: 7000, paymentMethod: "CASH", paymentStatus: "PENDING" });
    expect(recorded.json.data.outcome).toMatchObject({ chargedAmountMinor: 7000, paymentStatus: "PENDING", currency: "USD" }); // the technician holds the set
    const id = recorded.json.data.outcome.id;

    const dispatcher = (await getOutcome(w.cookie.dispatcher, id)).json.data;
    expect(dispatcher).toMatchObject({ id, outcome: "SOLD", visitNumber: 1 });
    for (const field of ["chargedAmountMinor", "quotedAmountMinor", "approvedAmountMinor", "collectedAmountMinor", "currency", "paymentMethod", "paymentStatus"]) {
      expect(dispatcher, field).not.toHaveProperty(field);
    }
    const listed = (await call(jobOutcomesRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } })).json.data[0];
    expect(listed).not.toHaveProperty("chargedAmountMinor");
    expect((await getOutcome(w.cookie.cityManagerA, id)).json.data.chargedAmountMinor).toBe(7000);
    expect((await getOutcome(w.cookie.finance, id)).json.data).toMatchObject({ chargedAmountMinor: 7000 });
  });

  it("keeps the original amount retrievable after a correction (history in the audit row, financial set required)", async () => {
    const job = await jobAt("IN_PROGRESS");
    const id = (await record(w.cookie.techA1, job.id, { outcome: "SOLD", chargedAmountMinor: 45000, paymentMethod: "CARD", paymentStatus: "PENDING" })).json.data.outcome.id;
    expect((await patchOutcome(w.cookie.cityManagerA, id, { reason: "Wrong total", chargedAmountMinor: 54000 })).json.data.chargedAmountMinor).toBe(54000);
    expect((await patchOutcome(w.cookie.cityManagerA, id, { reason: "Paid in full", chargedAmountMinor: 54000, collectedAmountMinor: 54000, paymentStatus: "PAID" })).status).toBe(200);

    const history = await call(correctionsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, params: { id } });
    expect(history.status).toBe(200);
    expect(history.json.data).toHaveLength(2);
    expect(history.json.data[0]).toMatchObject({ reason: "Wrong total", changedFields: ["chargedAmountMinor"], previous: { chargedAmountMinor: 45000 }, next: { chargedAmountMinor: 54000 } });
    expect(history.json.data[1]).toMatchObject({ reason: "Paid in full", previous: { collectedAmountMinor: null, paymentStatus: "PENDING" }, next: { collectedAmountMinor: 54000, paymentStatus: "PAID" } });

    expect((await call(correctionsRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id } })).status).toBe(403); // no edit
    expect((await call(correctionsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id } })).status).toBe(403);
    expect((await call(correctionsRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { id } })).status).toBe(404);
  });

  it("holds the outcome currency to the job's currency, on recording and on correction", async () => {
    const job = await jobAt("IN_PROGRESS");
    const refused = await record(w.cookie.techA1, job.id, { outcome: "SOLD", currency: "EUR", chargedAmountMinor: 100 });
    expect(refused.status).toBe(400);
    expect(refused.json.error.details[0].code).toBe("job_outcome.currency_mismatch");
    const id = (await record(w.cookie.techA1, job.id, { outcome: "SOLD", currency: "USD", chargedAmountMinor: 100 })).json.data.outcome.id;
    expect((await patchOutcome(w.cookie.cityManagerA, id, { reason: "Typo", currency: "EUR", chargedAmountMinor: 200 })).json.error.details[0].code).toBe("job_outcome.currency_mismatch");
    expect((await patchOutcome(w.cookie.cityManagerA, id, { reason: "Typo", currency: "USD" })).json.error.details[0].code).toBe("job_outcome.currency_alone");
    expect((await patchOutcome(w.cookie.cityManagerA, id, { reason: "Typo", currency: "USD", chargedAmountMinor: 200 })).json.data.chargedAmountMinor).toBe(200);
  });

  it("treats an omitted default and the same value sent explicitly as the same submission", async () => {
    const job = await jobAt("IN_PROGRESS");
    const clientEventId = randomUUID();
    const first = await record(w.cookie.techA1, job.id, { outcome: "SOLD", clientEventId });
    const again = await record(w.cookie.techA1, job.id, { outcome: "SOLD", clientEventId, currency: "usd", paymentStatus: "NOT_APPLICABLE", customerRequestedFollowUp: false });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.json.data.replayed).toBe(true);
  });

  it("re-checks permission on a replay: after the job closed the technician no longer reaches it", async () => {
    const job = await jobAt("IN_PROGRESS");
    const body = { outcome: "SOLD", clientEventId: randomUUID() };
    expect((await record(w.cookie.techA1, job.id, body)).status).toBe(201);
    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).status).toBe(200);
    expect([403, 404]).toContain((await record(w.cookie.techA1, job.id, body)).status);
  });

  it("refuses a time before the visit started", async () => {
    const job = await jobAt("IN_PROGRESS");
    const response = await record(w.cookie.techA1, job.id, { outcome: "SOLD", occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    expect(response.status).toBe(400);
    expect(response.json.error.details[0].code).toBe("job_outcome.occurred_too_early");
  });

  it("serializes two copies of one submission arriving together (one 201, one replay) and answers 409, not 500, when one id hits two jobs at once", async () => {
    const job = await jobAt("IN_PROGRESS");
    const body = { outcome: "SOLD", clientEventId: randomUUID() };
    const pair = await Promise.all([record(w.cookie.techA1, job.id, body), record(w.cookie.techA1, job.id, body)]);
    expect(pair.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await withTenant(w.tenantId, (tx) => tx.jobOutcome.count({ where: { jobId: job.id } }))).toBe(1);

    const jobOne = await jobAt("IN_PROGRESS");
    const jobTwo = await jobAt("IN_PROGRESS");
    const sharedId = randomUUID();
    const race = await Promise.all([
      record(w.cookie.techA1, jobOne.id, { outcome: "SOLD", clientEventId: sharedId }),
      record(w.cookie.techA1, jobTwo.id, { outcome: "SOLD", clientEventId: sharedId }),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await withTenant(w.tenantId, (tx) => tx.fieldEvent.count({ where: { clientEventId: sharedId } }))).toBe(1);
    expect(race.find((response) => response.status === 409)?.json.error.code).toBe("CONFLICT");
  });
});
