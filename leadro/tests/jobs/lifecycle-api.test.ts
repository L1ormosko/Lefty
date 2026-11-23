import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as historyRoute } from "@/app/api/v1/jobs/[id]/history/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/v1/jobs/workflow-settings/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { storeSoldOutcome } from "../job-outcomes/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-lifecycle");
});
afterAll(disconnect);

const move = (cookie: string, jobId: string, toStatus: string, reason?: string) =>
  call(transitionRoute, "POST", "/x", { cookie, params: { id: jobId }, body: reason === undefined ? { toStatus } : { toStatus, reason } });
const assign = (jobId: string, employeeId: string | null) => call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: jobId }, body: { employeeId } });
const schedule = (jobId: string) => {
  const start = Date.now() + 2 * 86_400_000;
  return call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: jobId },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
};
const statusOf = async (jobId: string) => (await call(getJobRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: jobId } })).json.data.status;

/** A job taken to SCHEDULED with technician A1 on it. */
async function scheduledJob(body: Record<string, unknown> = {}) {
  const job = await createJobViaApi(w, body);
  expect((await assign(job.id, w.techA1.employeeId)).status).toBe(200);
  expect((await schedule(job.id)).json.data.status).toBe("SCHEDULED");
  return job;
}

describe("walking the default path", () => {
  it("runs a job from creation to CLOSED, stamping its milestones and keeping a history row per step", async () => {
    const job = await scheduledJob();
    expect((await move(w.cookie.techA1, job.id, "EN_ROUTE")).json.data.status).toBe("EN_ROUTE");
    expect((await move(w.cookie.dispatcher, job.id, "ARRIVED")).json.data.status).toBe("ARRIVED");
    const started = (await move(w.cookie.dispatcher, job.id, "IN_PROGRESS")).json.data;
    expect(started.startedAt).toBeTruthy();
    const completed = (await move(w.cookie.dispatcher, job.id, "COMPLETED")).json.data;
    expect(completed.completedAt).toBeTruthy();
    await storeSoldOutcome(w.tenantId, job.id); // §9.1: closing needs the visit outcome
    const closed = (await move(w.cookie.dispatcher, job.id, "CLOSED")).json.data;
    expect(closed).toMatchObject({ status: "CLOSED", assignments: [] }); // the assignment ended with the work
    expect(closed.closedAt).toBeTruthy();

    const history = await call(historyRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, query: { limit: "50" } });
    expect(history.json.data.map((row: { toStatus: string }) => row.toStatus).reverse()).toEqual([
      "CREATED", "PENDING_ASSIGNMENT", "ASSIGNED", "SCHEDULED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "CLOSED",
    ]);
    expect((await auditEvents(w.tenantId, "job.status_change", job.id)).length).toBeGreaterThanOrEqual(7);
    expect((await call(getJobRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: job.id } })).status).toBe(404); // access ended with the assignment
  });

  it("sends COMPLETED through AWAITING_REVIEW for job types that require review, and only a jobs.approve holder closes it", async () => {
    const job = await scheduledJob({ jobTypeId: w.ids.reviewType });
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"]) expect((await move(w.cookie.dispatcher, job.id, status)).status).toBe(200);

    const skipped = await move(w.cookie.dispatcher, job.id, "CLOSED");
    expect(skipped.status).toBe(409);
    expect(skipped.json.error.message).toMatch(/review/);
    expect((await move(w.cookie.dispatcher, job.id, "AWAITING_REVIEW")).json.data.status).toBe("AWAITING_REVIEW");
    await storeSoldOutcome(w.tenantId, job.id);
    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).status).toBe(403); // approving is not a dispatcher's call
    expect((await move(w.cookie.ceo, job.id, "CLOSED")).json.data.status).toBe("CLOSED");
  });

  it("lets a reviewer reject the work (AWAITING_REVIEW back to IN_PROGRESS) only with jobs.reject", async () => {
    const job = await scheduledJob({ jobTypeId: w.ids.reviewType });
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "AWAITING_REVIEW"]) await move(w.cookie.dispatcher, job.id, status);
    expect((await move(w.cookie.dispatcher, job.id, "IN_PROGRESS")).status).toBe(403);
    expect((await move(w.cookie.ceo, job.id, "IN_PROGRESS")).json.data.status).toBe("IN_PROGRESS");
  });

  it("does not offer review to a job type that does not require it", async () => {
    const job = await scheduledJob();
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"]) await move(w.cookie.dispatcher, job.id, status);
    const response = await move(w.cookie.dispatcher, job.id, "AWAITING_REVIEW");
    expect(response.status).toBe(409);
    expect(response.json.error.message).toMatch(/does not require review/);
  });
});

describe("invalid transitions stay blocked (409 INVALID_STATE_TRANSITION)", () => {
  it("refuses edges that skip the path, go backwards or leave a terminal status, and writes nothing", async () => {
    const job = await createJobViaApi(w);
    for (const target of ["IN_PROGRESS", "COMPLETED", "CLOSED", "EN_ROUTE", "CREATED"]) {
      const response = await move(w.cookie.dispatcher, job.id, target);
      expect(response.status, target).toBe(409);
      expect(response.json.error.code).toBe("INVALID_STATE_TRANSITION");
    }
    expect(await statusOf(job.id)).toBe("PENDING_ASSIGNMENT");
    expect((await move(w.cookie.dispatcher, job.id, "PENDING_ASSIGNMENT")).status).toBe(409); // not a change

    await move(w.cookie.dispatcher, job.id, "CANCELLED", "Customer changed their mind");
    for (const target of ["PENDING_ASSIGNMENT", "ASSIGNED", "CLOSED"]) expect((await move(w.cookie.dispatcher, job.id, target)).status).toBe(409);
    const history = await withTenant(w.tenantId, (tx) => tx.jobStatusHistory.count({ where: { jobId: job.id } }));
    expect(history).toBe(3); // CREATED, PENDING_ASSIGNMENT, CANCELLED: refused attempts left no trace
  });

  it("needs somebody assigned for ASSIGNED and a time for SCHEDULED", async () => {
    const job = await createJobViaApi(w);
    const noOne = await move(w.cookie.dispatcher, job.id, "ASSIGNED");
    expect(noOne.status).toBe(409);
    expect(noOne.json.error.message).toMatch(/Assign the job/);
    await assign(job.id, w.techA1.employeeId);
    const noSlot = await move(w.cookie.dispatcher, job.id, "SCHEDULED");
    expect(noSlot.status).toBe(409);
    expect(noSlot.json.error.message).toMatch(/scheduled time/);
  });

  it("rejects unknown statuses and unknown body keys (400) and hides jobs of other cities (404)", async () => {
    const job = await createJobViaApi(w, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId });
    expect((await move(w.cookie.dispatcher, job.id, "FLYING")).status).toBe(400);
    expect((await call(transitionRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { toStatus: "CANCELLED", force: true } })).status).toBe(400);
    expect((await move(w.cookie.cityManagerA, job.id, "CANCELLED", "no")).status).toBe(404);
  });
});

describe("exceptional statuses", () => {
  it("demands a reason where something went wrong, and records it", async () => {
    const job = await scheduledJob();
    const missing = await move(w.cookie.dispatcher, job.id, "ON_HOLD");
    expect(missing.status).toBe(400);
    expect(missing.json.error.field).toBe("reason");
    const held = await move(w.cookie.dispatcher, job.id, "ON_HOLD", "Parts on back order");
    expect(held.json.data).toMatchObject({ status: "ON_HOLD", statusReason: "Parts on back order" });
    const history = await call(historyRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(history.json.data[0]).toMatchObject({ fromStatus: "SCHEDULED", toStatus: "ON_HOLD", reason: "Parts on back order", actorUserId: w.dispatcher.userId });
    expect((await move(w.cookie.dispatcher, job.id, "SCHEDULED")).json.data.status).toBe("SCHEDULED"); // resumed, assignment and slot kept
  });

  it("cancels with a reason: assignments end, the technician is told (critical, number only) and the job is terminal", async () => {
    const job = await scheduledJob();
    const cancelled = await move(w.cookie.dispatcher, job.id, "CANCELLED", "Customer cancelled by phone");
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", assignments: [], statusReason: "Customer cancelled by phone" });
    expect(cancelled.json.data.cancelledAt).toBeTruthy();
    const notices = await withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: w.techA1.userId, eventType: "job.cancelled" } }));
    expect(notices.some((row) => (row.params as { jobNumber: number }).jobNumber === job.number && row.critical)).toBe(true);
    expect((await move(w.cookie.dispatcher, job.id, "PENDING_ASSIGNMENT")).status).toBe(409);
  });

  it("handles a customer who is not home: CUSTOMER_UNAVAILABLE, RESCHEDULED, then back to SCHEDULED with a new slot", async () => {
    const job = await scheduledJob();
    for (const status of ["EN_ROUTE", "ARRIVED"]) await move(w.cookie.dispatcher, job.id, status);
    expect((await move(w.cookie.dispatcher, job.id, "CUSTOMER_UNAVAILABLE", "Nobody answered the door")).json.data.status).toBe("CUSTOMER_UNAVAILABLE");
    expect((await move(w.cookie.dispatcher, job.id, "RESCHEDULED", "Customer asked for next week")).json.data.status).toBe("RESCHEDULED");
    const next = await schedule(job.id);
    expect(next.json.data.status).toBe("SCHEDULED"); // a new slot on a RESCHEDULED job schedules it again
  });

  it("returns a failed or part-done job through REQUIRES_RETURN_VISIT or closes it", async () => {
    const job = await scheduledJob();
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"]) await move(w.cookie.dispatcher, job.id, status);
    expect((await move(w.cookie.dispatcher, job.id, "REQUIRES_RETURN_VISIT", "Part not on the truck")).json.data.status).toBe("REQUIRES_RETURN_VISIT");
    await storeSoldOutcome(w.tenantId, job.id);
    expect((await move(w.cookie.dispatcher, job.id, "CLOSED")).json.data.status).toBe("CLOSED");
  });
});

describe("technician limits", () => {
  it("lets an assigned technician mark EN_ROUTE and nothing else, and not touch a job that is not theirs", async () => {
    const job = await scheduledJob();
    for (const target of ["ARRIVED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "ON_HOLD", "CLOSED"]) {
      expect((await move(w.cookie.techA1, job.id, target, "x")).status, target).toBe(403);
    }
    expect((await move(w.cookie.techA1Other, job.id, "EN_ROUTE")).status).toBe(404);
    expect((await move(w.cookie.techA1, job.id, "EN_ROUTE")).status).toBe(200);
    expect((await move(w.cookie.techA1, job.id, "ARRIVED")).status).toBe(403);
  });
});

describe("tenant narrowing of the workflow", () => {
  const put = (cookie: string, disabledTransitions: string[]) => call(settingsPut, "PUT", "/x", { cookie, body: { disabledTransitions } });

  it("lists every transition, and only a tenant-wide job_types.configure holder changes the switches", async () => {
    const listed = await call(settingsGet, "GET", "/x", { cookie: w.cookie.dispatcher });
    expect(listed.status).toBe(200);
    expect(listed.json.data.transitions.length).toBeGreaterThan(40);
    expect(listed.json.data.disabledTransitions).toEqual([]);
    expect((await put(w.cookie.dispatcher, [])).status).toBe(403);
    expect((await put(w.cookie.cityManagerA, [])).status).toBe(403);
  });

  it("switches an optional transition off for everyone, audited, and can switch it back on", async () => {
    const job = await createJobViaApi(w);
    const disabled = await put(w.cookie.ceo, ["PENDING_ASSIGNMENT>CANCELLED"]);
    expect(disabled.status).toBe(200);
    expect(disabled.json.data.disabledTransitions).toEqual(["PENDING_ASSIGNMENT>CANCELLED"]);
    try {
      const blocked = await move(w.cookie.dispatcher, job.id, "CANCELLED", "no longer needed");
      expect(blocked.status).toBe(409);
      expect(blocked.json.error.message).toMatch(/switched off/);
      expect((await move(w.cookie.dispatcher, job.id, "ON_HOLD", "waiting")).status).toBe(200); // other optional edges still work
    } finally {
      expect((await put(w.cookie.ceo, [])).json.data.disabledTransitions).toEqual([]);
    }
    expect((await move(w.cookie.dispatcher, job.id, "PENDING_ASSIGNMENT")).status).toBe(200);
    expect((await move(w.cookie.dispatcher, job.id, "CANCELLED", "no longer needed")).status).toBe(200);
    const events = await auditEvents(w.tenantId, "job.workflow_update");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[events.length - 1].newValue).toMatchObject({ disabledTransitions: ["PENDING_ASSIGNMENT>CANCELLED"] });
  });

  it("refuses to switch off a core transition or to name one that does not exist (a tenant can only narrow)", async () => {
    const response = await put(w.cookie.ceo, ["SCHEDULED>EN_ROUTE", "CREATED>CLOSED"]);
    expect(response.status).toBe(400);
    expect(response.json.error.details.map((issue: { message: string }) => issue.message)).toEqual([
      expect.stringContaining("SCHEDULED>EN_ROUTE"),
      expect.stringContaining("CREATED>CLOSED"),
    ]);
    // Even if a bad value were stored (an older release, a manual edit), the machine ignores it.
    await withTenant(w.tenantId, (tx) =>
      tx.operationsSettings.upsert({ where: { tenantId: w.tenantId }, create: { tenantId: w.tenantId, disabledJobTransitions: ["SCHEDULED>EN_ROUTE"] }, update: { disabledJobTransitions: ["SCHEDULED>EN_ROUTE"] } }),
    );
    try {
      const job = await scheduledJob();
      expect((await move(w.cookie.dispatcher, job.id, "EN_ROUTE")).status).toBe(200);
    } finally {
      await put(w.cookie.ceo, []);
    }
  });
});
