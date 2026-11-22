import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as eventsRoute } from "@/app/api/v1/jobs/[id]/events/route";
import { GET as historyRoute } from "@/app/api/v1/jobs/[id]/history/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { GET as getJobRoute, PATCH as patchJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { GET as listJobsRoute } from "@/app/api/v1/jobs/route";
import { GET as mineRoute } from "@/app/api/v1/jobs/mine/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-schedule");
});
afterAll(disconnect);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const span = (startOffsetMs: number, durationMs: number) => ({ start: new Date(Date.now() + startOffsetMs).toISOString(), end: new Date(Date.now() + startOffsetMs + durationMs).toISOString() });
const reschedule = (cookie: string, jobId: string, body: Record<string, unknown>) => call(rescheduleRoute, "POST", "/x", { cookie, params: { id: jobId }, body });
const patch = (cookie: string, jobId: string, body: Record<string, unknown>) => call(patchJobRoute, "PATCH", "/x", { cookie, params: { id: jobId }, body });
const get = (cookie: string, jobId: string) => call(getJobRoute, "GET", "/x", { cookie, params: { id: jobId } });
const assign = (jobId: string, employeeId: string | null) => call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: jobId }, body: { employeeId } });

describe("rescheduling", () => {
  it("sets the appointment window on an unassigned job but needs an assignee for a scheduled slot", async () => {
    const job = await createJobViaApi(w);
    const window = span(2 * DAY, 4 * HOUR);
    const windowOnly = await reschedule(w.cookie.dispatcher, job.id, { appointmentWindow: window });
    expect(windowOnly.status).toBe(200);
    expect(windowOnly.json.data.appointmentWindowStart).toBe(window.start);
    expect(windowOnly.json.data.status).toBe("PENDING_ASSIGNMENT");

    const slot = await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: span(2 * DAY, 2 * HOUR) });
    expect(slot.status).toBe(400);
    expect(slot.json.error.field).toBe("scheduledSlot");
  });

  it("schedules an ASSIGNED job (status SCHEDULED), moves it again without a status change, notifies the technician and keeps an event and audit trail", async () => {
    const job = await createJobViaApi(w);
    await assign(job.id, w.techA1.employeeId);
    const first = await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: span(2 * DAY, 2 * HOUR) });
    expect(first.json.data.status).toBe("SCHEDULED");

    const next = span(3 * DAY, 2 * HOUR);
    const moved = await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: next, reason: "Customer asked for Thursday" });
    expect(moved.json.data).toMatchObject({ status: "SCHEDULED", scheduledStartAt: next.start, scheduledEndAt: next.end });

    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    const rescheduled = events.json.data.filter((row: { type: string }) => row.type === "job.rescheduled");
    expect(rescheduled).toHaveLength(2);
    expect(rescheduled[0].payload).toMatchObject({ reason: "Customer asked for Thursday", previous: { scheduledStartAt: expect.any(String) }, next: { scheduledStartAt: next.start } });
    expect((await auditEvents(w.tenantId, "job.reschedule", job.id))).toHaveLength(2);
    const notices = await withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: w.techA1.userId, eventType: "job.rescheduled", targetId: job.id } }));
    expect(notices).toHaveLength(2);

    const unchanged = await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: next });
    expect(unchanged.status).toBe(200);
    expect((await auditEvents(w.tenantId, "job.reschedule", job.id))).toHaveLength(2); // a no-op writes nothing
  });

  it("shows conflicts instead of refusing them: duration longer than the window or slot, and an assignee who is not available then", async () => {
    const job = await createJobViaApi(w); // estimated 120 minutes
    await assign(job.id, w.techA1.employeeId);
    const response = await reschedule(w.cookie.dispatcher, job.id, { appointmentWindow: span(2 * DAY, HOUR), scheduledSlot: span(2 * DAY, HOUR) });
    expect(response.status).toBe(200);
    const codes = response.json.data.warnings.map((warning: { code: string }) => warning.code);
    expect(codes).toEqual(expect.arrayContaining(["DURATION_EXCEEDS_WINDOW", "SLOT_SHORTER_THAN_DURATION", "ASSIGNEE_ELIGIBILITY_CONFLICT"])); // techA1 has no availability rows
    expect(response.json.data.status).toBe("SCHEDULED"); // the job is preserved
  });

  it("refuses to clear the slot of a SCHEDULED job, to reschedule work already under way, and an empty or inverted request", async () => {
    const job = await createJobViaApi(w);
    await assign(job.id, w.techA1.employeeId);
    await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: span(DAY, 2 * HOUR) });
    expect((await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: null })).status).toBe(409);
    expect((await reschedule(w.cookie.dispatcher, job.id, {})).status).toBe(400);
    expect((await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: { start: span(DAY, HOUR).end, end: span(DAY, HOUR).start } })).status).toBe(400);
    await call(transitionRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id }, body: { toStatus: "EN_ROUTE" } });
    const underway = await reschedule(w.cookie.dispatcher, job.id, { scheduledSlot: span(2 * DAY, 2 * HOUR) });
    expect(underway.status).toBe(409);
  });

  it("is not available to a technician, even on their own job (scheduling fields are outside the execution grant)", async () => {
    const job = await createJobViaApi(w);
    await assign(job.id, w.techA1.employeeId);
    expect((await reschedule(w.cookie.techA1, job.id, { appointmentWindow: span(DAY, 3 * HOUR) })).status).toBe(403);
  });
});

describe("editing a job (field-level write limits)", () => {
  it("lets a technician change only the technician instructions of their own job", async () => {
    const job = await createJobViaApi(w);
    await assign(job.id, w.techA1.employeeId);
    const allowed = await patch(w.cookie.techA1, job.id, { instructions: "Gate code 4411" });
    expect(allowed.status).toBe(200);
    expect(allowed.json.data.instructions).toBe("Gate code 4411");
    for (const forbidden of [{ title: "Mine now" }, { priority: "LOW" }, { estimatedDurationMinutes: 10 }, { description: "x" }, { quotedAmountMinor: 1 }, { instructions: "ok", title: "sneaky" }]) {
      const response = await patch(w.cookie.techA1, job.id, forbidden);
      expect(response.status, JSON.stringify(forbidden)).toBe(403);
    }
    expect((await get(w.cookie.dispatcher, job.id)).json.data).toMatchObject({ title: "HVAC repair", priority: "HIGH", instructions: "Gate code 4411" });
    expect((await patch(w.cookie.techA1Other, job.id, { instructions: "hijack" })).status).toBe(404);
  });

  it("lets a dispatcher change operational facts, records a priority event, and keeps money behind the financial grant", async () => {
    const job = await createJobViaApi(w);
    const changed = await patch(w.cookie.dispatcher, job.id, { title: "Rooftop unit repair", priority: "URGENT", description: "Compressor noise" });
    expect(changed.status).toBe(200);
    expect(changed.json.data).toMatchObject({ title: "Rooftop unit repair", priority: "URGENT", description: "Compressor noise" });
    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(events.json.data.map((row: { type: string }) => row.type)).toEqual(expect.arrayContaining(["job.updated", "job.priority_changed"]));
    expect(events.json.data.find((row: { type: string }) => row.type === "job.priority_changed").payload).toEqual({ from: "HIGH", to: "URGENT" });
    const [audit] = await auditEvents(w.tenantId, "job.update", job.id);
    expect(audit).toMatchObject({ previousValue: expect.objectContaining({ priority: "HIGH" }), newValue: expect.objectContaining({ priority: "URGENT" }) });

    expect((await patch(w.cookie.dispatcher, job.id, { quotedAmountMinor: 500 })).status).toBe(403);
    const priced = await patch(w.cookie.ceo, job.id, { quotedAmountMinor: 12_500 });
    expect(priced.json.data.quotedAmountMinor).toBe(12_500);
    expect((await auditEvents(w.tenantId, "job.update", job.id)).some((row) => JSON.stringify(row.newValue).includes("12500"))).toBe(false);
    expect((await get(w.cookie.dispatcher, job.id)).json.data).not.toHaveProperty("quotedAmountMinor");
  });

  it("answers 400 for empty or unknown input, 404 outside the scope, 409 for closed jobs and a no-op for unchanged values", async () => {
    const job = await createJobViaApi(w);
    expect((await patch(w.cookie.dispatcher, job.id, {})).status).toBe(400);
    expect((await patch(w.cookie.dispatcher, job.id, { status: "CLOSED" })).status).toBe(400);
    expect((await patch(w.cookie.cityManagerB, job.id, { title: "x" })).status).toBe(404);
    const before = (await auditEvents(w.tenantId, "job.update", job.id)).length;
    expect((await patch(w.cookie.dispatcher, job.id, { priority: "HIGH" })).status).toBe(200); // already HIGH
    expect((await auditEvents(w.tenantId, "job.update", job.id)).length).toBe(before);
    await call(transitionRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { toStatus: "CANCELLED", reason: "duplicate" } });
    expect((await patch(w.cookie.dispatcher, job.id, { title: "after cancel" })).status).toBe(409);
  });
});

describe("the technician's own jobs", () => {
  it("lists the caller's jobs only, soonest first and unscheduled last, hides finished work unless asked, and expands team assignments", async () => {
    const early = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const late = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const unscheduled = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const viaTeam = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const others = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const done = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    for (const job of [early, late, unscheduled, done]) await assign(job.id, w.techA1Other.employeeId);
    await assign(others.id, w.techA1.employeeId);
    await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: viaTeam.id }, body: { teamOrgUnitId: w.units.teamA1 } });
    await reschedule(w.cookie.dispatcher, late.id, { scheduledSlot: span(4 * DAY, HOUR) });
    await reschedule(w.cookie.dispatcher, early.id, { scheduledSlot: span(DAY, HOUR) });
    await call(transitionRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: done.id }, body: { toStatus: "CANCELLED", reason: "gone" } });

    const mine = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1Other, query: { limit: "200" } });
    const ids = mine.json.data.map((row: { id: string }) => row.id);
    expect(ids.slice(0, 2)).toEqual([early.id, late.id]);
    expect(ids).toEqual(expect.arrayContaining([unscheduled.id, viaTeam.id]));
    expect(ids).not.toContain(others.id);
    expect(ids).not.toContain(done.id); // cancelled: assignment ended and hidden
    expect(ids.indexOf(unscheduled.id)).toBeGreaterThan(1);
    expect(mine.json.data[0]).not.toHaveProperty("quotedAmountMinor");

    const only = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1Other, query: { status: "SCHEDULED" } });
    expect(only.json.data.map((row: { id: string }) => row.id).sort()).toEqual([early.id, late.id].sort());
    expect((await call(mineRoute, "GET", "/x", { cookie: w.cookie.techB })).json.data.map((row: { id: string }) => row.id)).not.toContain(early.id);
  });

  it("returns an empty page for a caller with no employee record and paginates", async () => {
    expect((await call(mineRoute, "GET", "/x", { cookie: w.cookie.ceo })).json).toEqual({ data: [], page: { nextCursor: null, limit: 50 } });
    for (let index = 0; index < 3; index += 1) await assign((await createJobViaApi(w, { jobTypeId: w.ids.reviewType })).id, w.techA1.employeeId);
    const first = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "2" } });
    expect(first.json.data).toHaveLength(2);
    expect(first.json.page.nextCursor).toBeTruthy();
    const second = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "2", cursor: first.json.page.nextCursor } });
    expect(second.json.data.length).toBeGreaterThan(0);
    expect(second.json.data.every((row: { id: string }) => !first.json.data.some((seen: { id: string }) => seen.id === row.id))).toBe(true);
  });

  it("lets a technician list only assigned jobs through the general list as well (ASSIGNED scope)", async () => {
    const mine = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const notMine = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    await assign(mine.id, w.techA1.employeeId);
    const listed = await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { limit: "200" } });
    const ids = listed.json.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(notMine.id);
  });
});

describe("filters, trails and the financial-only viewer", () => {
  it("filters by status, unassigned and text, and a financial-only grant can neither filter nor read the trails", async () => {
    const job = await createJobViaApi(w, { title: "Zebra-crossing sign repair" });
    const found = await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, query: { q: "zebra-crossing", status: "PENDING_ASSIGNMENT", unassigned: "true" } });
    expect(found.json.data.map((row: { id: string }) => row.id)).toContain(job.id);
    expect((await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, query: { q: `#${job.number}`, status: "ASSIGNED" } })).json.data).toEqual([]);
    expect((await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, query: { status: "BOGUS" } })).status).toBe(400);

    // Finance holds jobs.view {fields:"financial"}: rows show money only, so filters must not match and trails are closed.
    expect((await call(listJobsRoute, "GET", "/x", { cookie: w.cookie.finance, query: { q: "zebra-crossing" } })).json.data).toEqual([]);
    expect((await call(historyRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: job.id } })).status).toBe(403);
    expect((await call(eventsRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: job.id } })).status).toBe(403);
    expect((await call(historyRoute, "GET", "/x", { cookie: w.cookie.techB, params: { id: job.id } })).status).toBe(404);
  });
});
