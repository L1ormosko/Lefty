import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { POST as syncRoute } from "@/app/api/v1/field-sync/route";
import { withTenant } from "@/server/db";
import { clearFieldSyncHandlers, registerBuiltInFieldSyncHandlers, registerFieldSyncHandler, registeredFieldSyncTypes } from "@/server/field-sync";
import { disconnect } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { call } from "../org/org-helpers";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("field-sync");
});
afterAll(disconnect);
afterEach(() => {
  clearFieldSyncHandlers();
  registerBuiltInFieldSyncHandlers();
});

const move = (jobId: string, toStatus: string) => call(transitionRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: jobId }, body: { toStatus } });

async function jobInProgress() {
  const job = await createJobViaApi(w);
  await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  const start = Date.now() + 2 * 86_400_000;
  await call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: job.id },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
  for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"]) expect((await move(job.id, status)).status).toBe(200);
  return job;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const event = (type: string, jobId: string | undefined, payload: Record<string, unknown>, occurredAt: string, clientEventId = randomUUID()) => ({ clientEventId, type, jobId, occurredAt, payload });
const sync = (cookie: string, events: unknown[], batchId = `batch-${randomUUID()}`) => call(syncRoute, "POST", "/x", { cookie, body: { batchId, events } });
const fieldEvents = (ids: string[]) => withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { clientEventId: { in: ids } }, orderBy: { occurredAt: "asc" } }));

describe("POST /field-sync: ordering, results and isolation of failures", () => {
  it("applies events in occurredAt order (stable for ties) and answers in the order the device sent them", async () => {
    const job = await jobInProgress();
    const late = event("job.note", job.id, { body: "third" }, minutesAgo(1));
    const early = event("job.note", job.id, { body: "first" }, minutesAgo(30));
    const tieA = event("job.note", job.id, { body: "second a" }, minutesAgo(10));
    const tieB = event("job.note", job.id, { body: "second b" }, minutesAgo(10));
    const response = await sync(w.cookie.techA1, [late, early, tieA, tieB]);
    expect(response.status).toBe(200);
    const { results, summary } = response.json.data;
    expect(summary).toMatchObject({ total: 4, accepted: 4, rejected: 0 });
    expect(results.map((result: { clientEventId: string }) => result.clientEventId)).toEqual([late, early, tieA, tieB].map((item) => item.clientEventId));
    const sequenceOf = (id: string) => results.find((result: { clientEventId: string }) => result.clientEventId === id).sequence;
    expect([early, tieA, tieB, late].map((item) => sequenceOf(item.clientEventId))).toEqual([1, 2, 3, 4]);
    const stored = await withTenant(w.tenantId, (tx) => tx.jobFieldNote.findMany({ where: { jobId: job.id }, orderBy: { occurredAt: "asc" } }));
    expect(stored.map((note) => note.body)).toEqual(["first", "second a", "second b", "third"]);
  });

  it("never lets one failing event stop the batch, and reports each failure with its own status", async () => {
    const job = await jobInProgress();
    const otherJob = await createJobViaApi(w); // not the technician's, not in the field
    const good1 = event("job.note", job.id, { body: "before" }, minutesAgo(20));
    const invalid = event("job.note", job.id, { kind: "CUSTOMER_APPROVAL", body: "no decision" }, minutesAgo(19));
    const unknown = event("job.teleport", job.id, {}, minutesAgo(18));
    const notTheirs = event("job.note", otherJob.id, { body: "not mine" }, minutesAgo(17));
    const missingJob = event("job.note", undefined, { body: "no job" }, minutesAgo(16));
    const badState = event("job.completion", job.id, { notes: "x" }, minutesAgo(15)); // no active form for the type
    const good2 = event("job.material", job.id, { name: "Pipe", quantity: 2 }, minutesAgo(14));
    const response = await sync(w.cookie.techA1, [good1, invalid, unknown, notTheirs, missingJob, badState, good2]);
    expect(response.status).toBe(200);
    const byId = Object.fromEntries(response.json.data.results.map((result: { clientEventId: string }) => [result.clientEventId, result]));
    expect(byId[good1.clientEventId]).toMatchObject({ status: "ACCEPTED", retryable: false });
    expect(byId[invalid.clientEventId]).toMatchObject({ status: "REJECTED", code: "VALIDATION_FAILED", retryable: false });
    expect(byId[unknown.clientEventId]).toMatchObject({ status: "UNSUPPORTED", code: "UNSUPPORTED_EVENT_TYPE" });
    expect(byId[notTheirs.clientEventId]).toMatchObject({ status: "FORBIDDEN", retryable: true });
    expect(byId[missingJob.clientEventId]).toMatchObject({ status: "REJECTED", code: "VALIDATION_FAILED" });
    expect(byId[badState.clientEventId]).toMatchObject({ status: "CONFLICT", retryable: true });
    expect(byId[good2.clientEventId].status).toBe("ACCEPTED");
    expect(byId[good2.clientEventId].result.material).toMatchObject({ name: "Pipe", quantity: 2 });
    expect(response.json.data.summary).toEqual({ total: 7, accepted: 2, replayed: 0, rejected: 2, conflict: 1, forbidden: 1, unsupported: 1, failed: 0 });
    expect(await withTenant(w.tenantId, (tx) => tx.jobFieldNote.count({ where: { jobId: job.id } }))).toBe(1);
  });

  it("is safe to send again: a repeated batch replays every applied event and applies nothing twice", async () => {
    const job = await jobInProgress();
    const events = [event("job.note", job.id, { body: "once" }, minutesAgo(5)), event("job.material", job.id, { name: "Tape", quantity: 1 }, minutesAgo(4))];
    const first = await sync(w.cookie.techA1, events);
    expect(first.json.data.summary.accepted).toBe(2);
    const again = await sync(w.cookie.techA1, events);
    expect(again.status).toBe(200);
    expect(again.json.data.summary).toMatchObject({ accepted: 0, replayed: 2 });
    expect(again.json.data.results[0].result.note.id).toBe(first.json.data.results[0].result.note.id);
    expect(await withTenant(w.tenantId, (tx) => tx.jobFieldNote.count({ where: { jobId: job.id } }))).toBe(1);
    expect(await withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.count({ where: { jobId: job.id } }))).toBe(1);
  });

  it("answers CONFLICT when a clientEventId comes back with different content", async () => {
    const job = await jobInProgress();
    const original = event("job.note", job.id, { body: "original" }, minutesAgo(5));
    await sync(w.cookie.techA1, [original]);
    const changed = await sync(w.cookie.techA1, [{ ...original, payload: { body: "changed" } }]);
    expect(changed.json.data.results[0]).toMatchObject({ status: "CONFLICT", code: "CONFLICT" });
    expect(changed.json.data.results[0].details[0].code).toBe("CLIENT_EVENT_ID_REUSED");
    expect((await withTenant(w.tenantId, (tx) => tx.jobFieldNote.findMany({ where: { jobId: job.id } }))).map((note) => note.body)).toEqual(["original"]);
  });

  it("remembers a verdict on the content, but never a refusal caused by order or configuration (those stay retryable)", async () => {
    const job = await jobInProgress();
    // Content verdict: an amount in a currency that is not the job's will never be right.
    const wrong = event("job.note", job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "x", amountMinor: 5, currency: "EUR" }, minutesAgo(5));
    const first = (await sync(w.cookie.techA1, [wrong])).json.data.results[0];
    expect(first).toMatchObject({ status: "REJECTED", retryable: false });
    expect((await fieldEvents([wrong.clientEventId]))[0]).toMatchObject({ result: "REJECTED", type: "job.note" });
    expect((await sync(w.cookie.techA1, [wrong])).json.data.results[0]).toMatchObject({ status: "REJECTED" });
    expect((await sync(w.cookie.techA1, [wrong])).json.data.results[0].details[0].code).toBe(first.details[0].code); // the stored reason replays identically

    // State / configuration: no active form yet. Reported retryable and NOT stored, so it can succeed later.
    const early = event("job.completion", job.id, { notes: "x" }, minutesAgo(4));
    expect((await sync(w.cookie.techA1, [early])).json.data.results[0]).toMatchObject({ status: "CONFLICT", retryable: true });
    expect(await fieldEvents([early.clientEventId])).toHaveLength(0);

    // Order: a note for a job that is not in the field phase yet is retryable too.
    const scheduled = await createJobViaApi(w);
    await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: scheduled.id }, body: { employeeId: w.techA1.employeeId } });
    const tooSoon = event("job.note", scheduled.id, { body: "early" }, minutesAgo(3));
    expect((await sync(w.cookie.techA1, [tooSoon])).json.data.results[0]).toMatchObject({ status: "REJECTED", retryable: true });
    expect(await fieldEvents([tooSoon.clientEventId])).toHaveLength(0);
  });
});

describe("POST /field-sync: the technician's offline day (EN_ROUTE, navigation, arrival, start work, note)", () => {
  async function scheduledJob() {
    const job = await createJobViaApi(w);
    await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
    const start = Date.now() + 2 * 86_400_000;
    await call(rescheduleRoute, "POST", "/x", {
      cookie: w.cookie.dispatcher,
      params: { id: job.id },
      body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
    });
    return job;
  }
  const statusOf = async (jobId: string) => (await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId }, select: { status: true } }))).status;

  it("applies EN_ROUTE, navigation opened and a note from one batch, whatever order the device queued them in", async () => {
    const job = await scheduledJob();
    const enRoute = event("job.en_route", job.id, {}, minutesAgo(30));
    const nav = event("location.navigation_opened", job.id, {}, minutesAgo(25));
    const noted = event("job.note", job.id, { body: "On my way, gate code needed" }, minutesAgo(20));
    const response = await sync(w.cookie.techA1, [noted, nav, enRoute]);
    expect(response.json.data.results.map((result: { status: string }) => result.status)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED"]);
    expect(await statusOf(job.id)).toBe("EN_ROUTE");
    const row = (await fieldEvents([enRoute.clientEventId]))[0];
    expect(row).toMatchObject({ type: "job.en_route", result: "ACCEPTED", entityType: "Job", entityId: job.id });
    // The status change carries the device time, so arrival is ordered against when the technician really left.
    const history = await withTenant(w.tenantId, (tx) => tx.jobStatusHistory.findFirstOrThrow({ where: { jobId: job.id, toStatus: "EN_ROUTE" } }));
    expect(history.occurredAt.toISOString()).toBe(enRoute.occurredAt);
    const again = await sync(w.cookie.techA1, [noted, nav, enRoute]);
    expect(again.json.data.summary).toMatchObject({ accepted: 0, replayed: 3 });
  });

  it("continues through arrival and start work, and reports an out-of-order step as retryable (not stored)", async () => {
    const job = await scheduledJob();
    const arrive = event("job.arrive", job.id, { exception: { code: "DEVICE_OFFLINE" } }, minutesAgo(20));
    const early = (await sync(w.cookie.techA1, [arrive])).json.data.results[0];
    expect(early).toMatchObject({ status: "REJECTED", retryable: true }); // still SCHEDULED: the EN_ROUTE event has not arrived
    expect(await fieldEvents([arrive.clientEventId])).toHaveLength(0);
    const enRoute = event("job.en_route", job.id, {}, minutesAgo(30));
    const startWork = event("job.start_work", job.id, {}, minutesAgo(10));
    const response = await sync(w.cookie.techA1, [startWork, arrive, enRoute]);
    expect(response.json.data.results.map((result: { type: string; status: string }) => [result.type, result.status])).toEqual([
      ["job.start_work", "ACCEPTED"],
      ["job.arrive", "ACCEPTED"],
      ["job.en_route", "ACCEPTED"],
    ]);
    expect(await statusOf(job.id)).toBe("IN_PROGRESS");
  });

  it("refuses the offline envelope for any other transition, and a replayed EN_ROUTE after the job moved on still answers", async () => {
    const job = await scheduledJob();
    const refused = await call(transitionRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { toStatus: "ARRIVED", clientEventId: randomUUID() } });
    expect(refused.status).toBe(400);
    const clientEventId = randomUUID();
    const first = await call(transitionRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { toStatus: "EN_ROUTE", clientEventId } });
    expect(first.status).toBe(200);
    expect((await move(job.id, "ARRIVED")).status).toBe(200);
    const replay = await call(transitionRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { toStatus: "EN_ROUTE", clientEventId } });
    expect(replay.status).toBe(200);
    expect(replay.json.data.replayed).toBe(true);
  });
});

describe("POST /field-sync: a far-future device time is never accepted", () => {
  it("refuses offline arrive and start-work dated a year ahead as retryable, and stores nothing", async () => {
    const job = await jobInProgress();
    const nextYear = new Date(Date.now() + 366 * 86_400_000).toISOString();
    const arrive = event("job.arrive", job.id, { exception: { code: "DEVICE_OFFLINE" } }, nextYear);
    const startWork = event("job.start_work", job.id, {}, nextYear);
    const results = (await sync(w.cookie.techA1, [arrive, startWork])).json.data.results;
    expect(results.map((result: { status: string; retryable: boolean }) => [result.status, result.retryable])).toEqual([["REJECTED", true], ["REJECTED", true]]);
    expect(await fieldEvents([arrive.clientEventId, startWork.clientEventId])).toHaveLength(0);
  });
});

describe("POST /field-sync: an event that arrived before its predecessor can be sent again", () => {
  it("does not remember 'job_outcome.not_reportable' while the job can still advance, so the same event succeeds after start-work", async () => {
    const job = await createJobViaApi(w);
    await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
    const start = Date.now() + 2 * 86_400_000;
    await call(rescheduleRoute, "POST", "/x", {
      cookie: w.cookie.dispatcher,
      params: { id: job.id },
      body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
    });
    for (const status of ["EN_ROUTE", "ARRIVED"]) expect((await move(job.id, status)).status).toBe(200);
    const outcome = event("job.outcome", job.id, { outcome: "SOLD", chargedAmountMinor: 500 }, new Date(Date.now() + 1000).toISOString());
    const early = (await sync(w.cookie.techA1, [outcome])).json.data.results[0];
    expect(early).toMatchObject({ status: "REJECTED", retryable: true });
    expect(await fieldEvents([outcome.clientEventId])).toHaveLength(0);
    expect((await move(job.id, "IN_PROGRESS")).status).toBe(200);
    expect((await sync(w.cookie.techA1, [outcome])).json.data.results[0].status).toBe("ACCEPTED");
  });
});

describe("POST /field-sync: batch id, event types and the registry", () => {
  it("stores the batch id on every event row (accepted or refused) and keeps the first batch on a replay", async () => {
    const job = await jobInProgress();
    const ok = event("job.note", job.id, { body: "labelled" }, minutesAgo(5));
    const refused = event("job.note", job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "x", amountMinor: 5, currency: "EUR" }, minutesAgo(4));
    const batchId = `batch-${randomUUID()}`;
    await sync(w.cookie.techA1, [ok, refused], batchId);
    const rows = await fieldEvents([ok.clientEventId, refused.clientEventId]);
    expect(rows.map((row) => row.batchId)).toEqual([batchId, batchId]);
    expect(rows.every((row) => row.employeeId === w.techA1.employeeId)).toBe(true);
    await sync(w.cookie.techA1, [ok], `batch-${randomUUID()}`);
    expect((await fieldEvents([ok.clientEventId]))[0].batchId).toBe(batchId);
  });

  it("applies the built-in types: shift start/end, job outcome, location events, attachments and completion go through their modules", async () => {
    const job = await jobInProgress();
    const shift = event("shift.start", undefined, { exception: { code: "DEVICE_OFFLINE" } }, minutesAgo(60));
    const nav = event("location.navigation_opened", job.id, {}, minutesAgo(50));
    const photo = event("job.attachment", job.id, { kind: "PHOTO", fileName: "a.jpg", contentType: "image/jpeg", sizeBytes: 10 }, minutesAgo(30));
    const outcome = event("job.outcome", job.id, { outcome: "SOLD", chargedAmountMinor: 1000 }, new Date(Date.now() + 1000).toISOString());
    const response = await sync(w.cookie.techA1, [outcome, photo, nav, shift]);
    const statuses = Object.fromEntries(response.json.data.results.map((result: { type: string; status: string }) => [result.type, result.status]));
    expect(statuses).toEqual({ "shift.start": "ACCEPTED", "location.navigation_opened": "ACCEPTED", "job.attachment": "ACCEPTED", "job.outcome": "ACCEPTED" });
    expect((await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: job.id } }))).status).toBe("COMPLETED");
    // The FieldEvent of each carries its module's type, the job and no free text or coordinates.
    const rows = await fieldEvents([shift, nav, photo, outcome].map((item) => item.clientEventId));
    expect(rows.map((row) => row.type)).toEqual(["shift.start", "location.navigation_opened", "job.attachment", "job.outcome"]);

    const end = await sync(w.cookie.techA1, [event("shift.end", undefined, { exception: { code: "DEVICE_OFFLINE" } }, minutesAgo(1))]);
    expect(end.json.data.results[0].status).toBe("ACCEPTED");
  });

  it("lets a module register its own event type (how arrival plugs in), and refuses a duplicate owner", async () => {
    registerFieldSyncHandler("job.arrival_test", async ({ event: incoming, actor }) => ({ echoed: incoming.payload.value, employeeId: actor.employeeId }));
    expect(registeredFieldSyncTypes()).toContain("job.arrival_test");
    expect(() => registerFieldSyncHandler("job.arrival_test", async () => null)).toThrow(/already registered/);
    expect(() => registerFieldSyncHandler("Bad Type", async () => null)).toThrow(/dotted lower-case/);
    const job = await jobInProgress();
    const response = await sync(w.cookie.techA1, [event("job.arrival_test", job.id, { value: 7 }, minutesAgo(1))]);
    expect(response.json.data.results[0]).toMatchObject({ status: "ACCEPTED", result: { echoed: 7, employeeId: w.techA1.employeeId } });
  });

  it("turns an unexpected handler error into a retryable FAILED result without leaking details", async () => {
    registerFieldSyncHandler("job.explodes", async () => {
      throw new Error("secret internals");
    });
    const response = await sync(w.cookie.techA1, [event("job.explodes", undefined, {}, minutesAgo(1))]);
    expect(response.status).toBe(200);
    expect(response.json.data.results[0]).toMatchObject({ status: "FAILED", code: "INTERNAL", retryable: true });
    expect(JSON.stringify(response.json)).not.toContain("secret internals");
  });
});

describe("POST /field-sync: request validation", () => {
  const valid = () => event("job.note", "x", { body: "y" }, minutesAgo(1));

  it("rejects malformed batches with 400 and anonymous callers with 401", async () => {
    expect((await sync(w.cookie.techA1, [])).status).toBe(400);
    expect((await sync(w.cookie.techA1, Array.from({ length: 101 }, valid))).status).toBe(400);
    expect((await sync(w.cookie.techA1, [valid()], "short")).status).toBe(400);
    expect((await sync(w.cookie.techA1, [{ ...valid(), clientEventId: "not-a-uuid" }])).status).toBe(400);
    expect((await sync(w.cookie.techA1, [{ ...valid(), type: "NoDots" }])).status).toBe(400);
    expect((await sync(w.cookie.techA1, [{ ...valid(), occurredAt: "yesterday" }])).status).toBe(400);
    expect((await call(syncRoute, "POST", "/x", { body: { batchId: "batch-12345678", events: [valid()] } })).status).toBe(401);
  });

  it("refuses events from the future or older than a week, per event", async () => {
    const job = await jobInProgress();
    const future = event("job.note", job.id, { body: "later" }, new Date(Date.now() + 3_600_000).toISOString());
    const ancient = event("job.note", job.id, { body: "ancient" }, new Date(Date.now() - 30 * 86_400_000).toISOString());
    const response = await sync(w.cookie.techA1, [future, ancient]);
    expect(response.json.data.results.map((result: { status: string }) => result.status)).toEqual(["REJECTED", "REJECTED"]);
  });
});
