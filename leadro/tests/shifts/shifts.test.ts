import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import type { JobsWorld } from "../jobs/fixtures";
import { buildFieldWorld, clearActiveShifts, current, endById, endOwn, getShift, listShifts, position, review, shiftEvents, start } from "./fixtures";

let w: JobsWorld;
let tech: string;
beforeAll(async () => {
  w = await buildFieldWorld("shifts");
  tech = w.techA1.employeeId as string;
});
afterAll(disconnect);

/** Each test starts with the technician off shift. */
const offShift = () => clearActiveShifts(w.tenantId, tech);
const startShiftNow = async () => (await start(w.cookie.techA1, { position: position() })).json.data;

describe("starting a shift", () => {
  it("records the shift with a location event (accuracy, both clocks), the org unit snapshot, an audit event, and echoes no coordinates", async () => {
    await offShift();
    const deviceTime = new Date(Date.now() - 20_000).toISOString();
    const response = await start(w.cookie.techA1, { deviceId: "pixel-7", position: position({ deviceTime }) });
    expect(response.status).toBe(201);
    const shift = response.json.data;
    expect(shift).toMatchObject({ employeeId: tech, status: "ACTIVE", orgUnitId: w.units.teamA1, startException: null, exceptionReviewStatus: null, endedAt: null, deviceId: "pixel-7" });
    expect(JSON.stringify(response.json)).not.toMatch(/latitude|longitude/);

    const [event] = await shiftEvents(w.tenantId, shift.id);
    expect(event).toMatchObject({ kind: "SHIFT_START", source: "DEVICE_GPS", accuracyM: 13, employeeId: tech, orgUnitId: w.units.teamA1, exception: null });
    expect(event.deviceTime?.toISOString()).toBe(deviceTime);
    expect(event.serverTime.getTime()).toBeGreaterThan(event.deviceTime!.getTime());
    expect(shift.startLocationEventId).toBe(event.id);

    const [audit] = await auditEvents(w.tenantId, "shift.start", shift.id);
    expect(audit.actorUserId).toBe(w.techA1.userId);
    expect(JSON.stringify(audit.newValue)).not.toMatch(/latitude|longitude|40\.0|-89/);
  });

  it("is idempotent: starting while on shift returns the running shift and records nothing new", async () => {
    await offShift();
    const first = await start(w.cookie.techA1, { position: position() });
    const second = await start(w.cookie.techA1, { position: position() });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(await shiftEvents(w.tenantId, first.json.data.id)).toHaveLength(1);
  });

  it("creates exactly one shift when two starts race", async () => {
    await offShift();
    const responses = await Promise.all([start(w.cookie.techA1, { position: position() }), start(w.cookie.techA1, { position: position() }), start(w.cookie.techA1, { position: position() })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(responses.map((response) => response.json.data.id)).size).toBe(1);
    expect(await withTenant(w.tenantId, (tx) => tx.shift.count({ where: { tenantId: w.tenantId, employeeId: tech, status: "ACTIVE" } }))).toBe(1);
  });

  it("refuses a start with neither a position nor a reason, and a position without accuracy", async () => {
    await offShift();
    expect((await start(w.cookie.techA1, {})).status).toBe(400);
    const { accuracyM: _omit, ...noAccuracy } = position();
    expect((await start(w.cookie.techA1, { position: noAccuracy })).status).toBe(400);
    expect((await start(w.cookie.techA1, { exception: { code: "OTHER" } })).status).toBe(400);
    expect(await withTenant(w.tenantId, (tx) => tx.shift.count({ where: { tenantId: w.tenantId, employeeId: tech, status: "ACTIVE" } }))).toBe(0);
  });

  it("accepts a manual start with a reason (GPS disabled) and queues it for manager review", async () => {
    await offShift();
    const response = await start(w.cookie.techA1, { exception: { code: "GPS_DISABLED", note: "Location services are off on this phone" } });
    expect(response.status).toBe(201);
    expect(response.json.data).toMatchObject({ startException: "GPS_DISABLED", startExceptionNote: "Location services are off on this phone", exceptionReviewStatus: "PENDING", reviewedById: null });
    const [event] = await shiftEvents(w.tenantId, response.json.data.id);
    expect(event).toMatchObject({ source: "MANUAL", exception: "GPS_DISABLED", accuracyM: null, latitude: null });
  });

  it("keeps a position that is too vague to be evidence but flags the start as POOR_SIGNAL for review", async () => {
    await offShift();
    const response = await start(w.cookie.techA1, { position: position({ accuracyM: 800 }) });
    expect(response.status).toBe(201);
    expect(response.json.data).toMatchObject({ startException: "POOR_SIGNAL", exceptionReviewStatus: "PENDING" });
    const [event] = await shiftEvents(w.tenantId, response.json.data.id);
    expect(event.accuracyM).toBe(800);
    expect(event.latitude).not.toBeNull();
  });

  it("needs shifts.create and an employee profile: manager 403, Owner without employee 403, anonymous 401", async () => {
    expect((await start(w.cookie.cityManagerA, { position: position() })).status).toBe(403);
    expect((await start(w.cookie.ceo, { position: position() })).status).toBe(403);
    expect((await start("", { position: position() })).status).toBe(401);
  });

  it("refuses a start that overlaps the previous shift, and an event time in the future", async () => {
    await offShift();
    expect((await start(w.cookie.techA1, { occurredAt: new Date(Date.now() - 3_600_000).toISOString(), position: position() })).status).toBe(409);
    expect((await start(w.cookie.techA1, { occurredAt: new Date(Date.now() + 3_600_000).toISOString(), position: position() })).status).toBe(400);
  });
});

describe("the current shift", () => {
  it("is the caller's active shift, or null when off shift", async () => {
    await offShift();
    expect((await current(w.cookie.techA1)).json).toEqual({ data: null });
    const shift = await startShiftNow();
    expect((await current(w.cookie.techA1)).json.data.id).toBe(shift.id);
    expect((await current(w.cookie.techA1Other)).json.data?.id).not.toBe(shift.id);
  });
});

describe("ending a shift", () => {
  it("ends the caller's own shift with an end event, audit, and is idempotent", async () => {
    await offShift();
    const shift = await startShiftNow();
    const ended = await endOwn(w.cookie.techA1, { position: position() });
    expect(ended.status).toBe(200);
    expect(ended.json.data).toMatchObject({ id: shift.id, status: "ENDED", endException: null, endedByUserId: null });
    expect(new Date(ended.json.data.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(shift.startedAt).getTime());
    const events = await shiftEvents(w.tenantId, shift.id);
    expect(events.map((event) => event.kind)).toEqual(["SHIFT_START", "SHIFT_END"]);
    expect(ended.json.data.endLocationEventId).toBe(events[1].id);
    expect((await auditEvents(w.tenantId, "shift.end", shift.id))[0].actorUserId).toBe(w.techA1.userId);

    const again = await endOwn(w.cookie.techA1, { position: position() });
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ id: shift.id, status: "ENDED", endedAt: ended.json.data.endedAt });
    expect(await shiftEvents(w.tenantId, shift.id)).toHaveLength(2);
    expect((await current(w.cookie.techA1)).json).toEqual({ data: null });
  });

  it("ends by id too, and refuses ending before the start or a blank capture", async () => {
    await offShift();
    const shift = await startShiftNow();
    expect((await endById(w.cookie.techA1, shift.id, {})).status).toBe(400);
    expect((await endById(w.cookie.techA1, shift.id, { occurredAt: new Date(Date.now() - 3_600_000).toISOString(), position: position() })).status).toBe(409);
    expect((await endById(w.cookie.techA1, shift.id, { position: position() })).json.data.status).toBe("ENDED");
  });

  it("opens a review when the end carries an exception, and keeps an earlier decision when the end is clean", async () => {
    await offShift();
    const flagged = (await start(w.cookie.techA1, { exception: { code: "PERMISSION_DENIED" } })).json.data;
    expect((await review(w.cookie.cityManagerA, flagged.id, { decision: "APPROVED", note: "Known device issue" })).status).toBe(200);
    const cleanEnd = await endOwn(w.cookie.techA1, { position: position() });
    expect(cleanEnd.json.data).toMatchObject({ exceptionReviewStatus: "APPROVED", reviewNote: "Known device issue" });

    await offShift();
    const clean = await startShiftNow();
    const offlineEnd = await endById(w.cookie.techA1, clean.id, { exception: { code: "DEVICE_OFFLINE", note: "No signal in the basement" } });
    expect(offlineEnd.json.data).toMatchObject({ endException: "DEVICE_OFFLINE", exceptionReviewStatus: "PENDING" });
  });

  it("lets a manager end someone else's shift with a reason: recorded as the manager's entry, audited, no device position accepted", async () => {
    await offShift();
    const shift = await startShiftNow();
    expect((await endById(w.cookie.cityManagerA, shift.id, {})).status).toBe(400); // reason required
    expect((await endById(w.cookie.cityManagerA, shift.id, { reason: "Left the van running", position: position() })).status).toBe(400);
    const ended = await endById(w.cookie.cityManagerA, shift.id, { reason: "Technician forgot to end the shift" });
    expect(ended.status).toBe(200);
    expect(ended.json.data).toMatchObject({ status: "ENDED", endedByUserId: w.cityManagerA.userId, endReason: "Technician forgot to end the shift", endException: null });
    const events = await shiftEvents(w.tenantId, shift.id);
    expect(events[1]).toMatchObject({ kind: "SHIFT_END", source: "MANAGER", recordedByUserId: w.cityManagerA.userId, latitude: null });
    const [audit] = await auditEvents(w.tenantId, "shift.end_by_manager", shift.id);
    expect(audit).toMatchObject({ actorUserId: w.cityManagerA.userId, reason: "Technician forgot to end the shift" });
  });

  it("keeps ending inside scope: another unit's manager 404, a viewer 403, another technician 404", async () => {
    await offShift();
    const shift = await startShiftNow();
    expect((await endById(w.cookie.cityManagerB, shift.id, { reason: "Not my person" })).status).toBe(404);
    expect((await endById(w.cookie.dispatcher, shift.id, { reason: "View only" })).status).toBe(403);
    expect((await endById(w.cookie.techA1Other, shift.id, { position: position() })).status).toBe(404);
    expect((await endById(w.cookie.techA1, "no-such-shift", { position: position() })).status).toBe(404);
    expect((await getShift(w.cookie.techA1, shift.id)).json.data.status).toBe("ACTIVE");
  });
});

describe("ending: races and the id-less end", () => {
  it("lets two concurrent ends of the same shift both succeed with one SHIFT_END event", async () => {
    await offShift();
    const shift = await startShiftNow();
    const [a, b] = await Promise.all([endById(w.cookie.techA1, shift.id, { position: position() }), endById(w.cookie.cityManagerA, shift.id, { reason: "Racing the technician" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const events = await shiftEvents(w.tenantId, shift.id);
    expect(events.filter((event) => event.kind === "SHIFT_END")).toHaveLength(1);
  });

  it("serialises an end racing a review: the decision is kept and the shift ends exactly once", async () => {
    await offShift();
    const shift = (await start(w.cookie.techA1, { exception: { code: "GPS_DISABLED" } })).json.data;
    const [ended, reviewed] = await Promise.all([
      endById(w.cookie.techA1, shift.id, { position: position() }),
      review(w.cookie.cityManagerA, shift.id, { decision: "APPROVED", note: "Accepted while ending" }),
    ]);
    expect(ended.status).toBe(200);
    expect(reviewed.status).toBe(200);
    const final = (await getShift(w.cookie.cityManagerA, shift.id)).json.data;
    expect(final).toMatchObject({ status: "ENDED", exceptionReviewStatus: "APPROVED", reviewNote: "Accepted while ending" });
  });

  it("POST /shifts/end without an id ends the CURRENT shift after start, end, start", async () => {
    await offShift();
    const first = await startShiftNow();
    expect((await endOwn(w.cookie.techA1, { position: position() })).json.data.id).toBe(first.id);
    const second = await startShiftNow();
    expect(second.id).not.toBe(first.id);
    const ended = await endOwn(w.cookie.techA1, { position: position() });
    expect(ended.json.data).toMatchObject({ id: second.id, status: "ENDED" });
    expect((await getShift(w.cookie.techA1, first.id)).json.data.endedAt).not.toBe(ended.json.data.endedAt);
  });
});

describe("reviewing a shift exception (shifts.approve)", () => {
  it("lets a manager over the unit approve or reject once, with a mandatory note, recording who and when", async () => {
    await offShift();
    const shift = (await start(w.cookie.techA1, { exception: { code: "GPS_DISABLED", note: "Phone setting" } })).json.data;
    expect((await review(w.cookie.cityManagerA, shift.id, { decision: "REJECTED" })).status).toBe(400);
    const decided = await review(w.cookie.cityManagerA, shift.id, { decision: "REJECTED", note: "Start time not credible" });
    expect(decided.status).toBe(200);
    expect(decided.json.data).toMatchObject({ exceptionReviewStatus: "REJECTED", reviewedById: w.cityManagerA.userId, reviewNote: "Start time not credible", status: "ACTIVE" });
    expect(decided.json.data.reviewedAt).toBeTruthy();
    expect((await auditEvents(w.tenantId, "shift.exception_review", shift.id))[0]).toMatchObject({ actorUserId: w.cityManagerA.userId, reason: "Start time not credible" });

    const second = await review(w.cookie.ceo, shift.id, { decision: "APPROVED", note: "Changed my mind" });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("refuses a shift with no exception, other units' managers, the technician and view-only roles", async () => {
    await offShift();
    const clean = await startShiftNow();
    expect((await review(w.cookie.cityManagerA, clean.id, { decision: "APPROVED", note: "n/a" })).status).toBe(409);
    await offShift();
    const flagged = (await start(w.cookie.techA1, { exception: { code: "DEVICE_OFFLINE" } })).json.data;
    expect((await review(w.cookie.cityManagerB, flagged.id, { decision: "APPROVED", note: "Not mine" })).status).toBe(404);
    expect((await review(w.cookie.techA1, flagged.id, { decision: "APPROVED", note: "Self" })).status).toBe(403);
    expect((await review(w.cookie.dispatcher, flagged.id, { decision: "APPROVED", note: "View only" })).status).toBe(403);
    expect((await getShift(w.cookie.techA1, flagged.id)).json.data.exceptionReviewStatus).toBe("PENDING");
  });

  it("never lets someone approve their own shift (separation of duties)", async () => {
    const roleId = await makeRole(w.tenantId, "Self reviewer", [{ permission: "shifts.approve" }, { permission: "shifts.view" }]);
    await grantTemplate(w.tenantId, w.techB, roleId, [{ type: "OWN" }]);
    const shift = (await start(w.cookie.techB, { exception: { code: "POOR_SIGNAL" } })).json.data;
    const own = await review(w.cookie.techB, shift.id, { decision: "APPROVED", note: "Looks fine to me" });
    expect(own.status).toBe(403);
    expect((await getShift(w.cookie.techB, shift.id)).json.data.exceptionReviewStatus).toBe("PENDING");
  });
});

describe("offline shifts (clientEventId + occurredAt)", () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  it("replays a start and an end safely, orders by the device clock and rejects a changed event", async () => {
    // A fresh employee (techA1Other) so the overlap rule is not affected by the other tests.
    const cookie = w.cookie.techA1Other;
    const startId = crypto.randomUUID();
    const endId = crypto.randomUUID();
    const startedAt = hoursAgo(5);
    const endedAt = hoursAgo(1);

    const firstStart = await start(cookie, { clientEventId: startId, occurredAt: startedAt.toISOString(), position: position({ deviceTime: startedAt.toISOString() }) });
    const replayedStart = await start(cookie, { clientEventId: startId, occurredAt: startedAt.toISOString(), position: position({ deviceTime: startedAt.toISOString() }) });
    expect(firstStart.status).toBe(201);
    expect(replayedStart.status).toBe(200);
    expect(replayedStart.json.data.id).toBe(firstStart.json.data.id);
    expect(new Date(firstStart.json.data.startedAt).toISOString()).toBe(startedAt.toISOString());
    expect(new Date(firstStart.json.data.startRecordedAt).getTime()).toBeGreaterThan(startedAt.getTime()); // dual timestamps on the shift
    // A boundary reported hours late is an exception on its own: the server raises DELAYED and queues the review.
    expect(firstStart.json.data).toMatchObject({ startException: "DELAYED", exceptionReviewStatus: "PENDING" });

    const changed = await start(cookie, { clientEventId: startId, occurredAt: startedAt.toISOString(), position: position({ latitude: 41, deviceTime: startedAt.toISOString() }) });
    expect(changed.status).toBe(409);

    const end = { clientEventId: endId, occurredAt: endedAt.toISOString(), position: position({ deviceTime: endedAt.toISOString() }) };
    const firstEnd = await endOwn(cookie, end);
    const replayedEnd = await endOwn(cookie, end);
    expect(firstEnd.status).toBe(200);
    expect(replayedEnd.json.data.id).toBe(firstStart.json.data.id);
    expect(new Date(firstEnd.json.data.endedAt).toISOString()).toBe(endedAt.toISOString());
    expect(firstEnd.json.data.endException).toBe("DELAYED");
    expect(await shiftEvents(w.tenantId, firstStart.json.data.id)).toHaveLength(2);

    const logged = await withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { tenantId: w.tenantId, clientEventId: { in: [startId, endId] } }, orderBy: { type: "asc" } }));
    expect(logged.map((row) => [row.type, row.result, row.entityType])).toEqual([
      ["shift.end", "ACCEPTED", "Shift"],
      ["shift.start", "ACCEPTED", "Shift"],
    ]);
    expect(JSON.stringify(logged.map((row) => row.payload))).not.toMatch(/latitude|longitude/);
  });

  it("stores a refused event as REJECTED and refuses its replay too", async () => {
    const cookie = w.cookie.techB;
    await clearActiveShifts(w.tenantId, w.techB.employeeId as string);
    // Shifts that ended long ago are not a retry of "end": move them back in time (retry window is 5 minutes).
    await withTenant(w.tenantId, (tx) =>
      tx.shift.updateMany({ where: { tenantId: w.tenantId, employeeId: w.techB.employeeId as string }, data: { startedAt: hoursAgo(3), endedAt: hoursAgo(2), endRecordedAt: hoursAgo(2) } }),
    );
    const eventId = crypto.randomUUID();
    const body = { clientEventId: eventId, occurredAt: new Date().toISOString(), position: position() };
    // Nothing to end: the first delivery is refused (no shift) and remembered.
    const first = await endOwn(cookie, body);
    expect(first.status).toBe(409);
    await start(cookie, { position: position() }); // a shift now exists, but this event id was already refused
    const replay = await endOwn(cookie, body);
    expect(replay.status).toBe(409);
    expect((await current(cookie)).json.data.status).toBe("ACTIVE");
    const [row] = await withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { tenantId: w.tenantId, clientEventId: eventId } }));
    expect(row).toMatchObject({ result: "REJECTED", resultCode: "INVALID_STATE_TRANSITION", type: "shift.end" });
  });
});

describe("reading shifts (scope and projection)", () => {
  it("shows a technician only their own shifts and a manager only their unit's, with filters and paging", async () => {
    await offShift();
    const mine = await startShiftNow();
    const cityB = (await start(w.cookie.techB, { position: position() })).json.data ?? (await current(w.cookie.techB)).json.data;

    const own = await listShifts(w.cookie.techA1, { limit: "200" });
    expect(own.status).toBe(200);
    expect(own.json.data.every((row: { employeeId: string }) => row.employeeId === tech)).toBe(true);
    expect(own.json.data.map((row: { id: string }) => row.id)).toContain(mine.id);

    const asManagerA = await listShifts(w.cookie.cityManagerA, { limit: "200" });
    const idsA = asManagerA.json.data.map((row: { id: string }) => row.id);
    expect(idsA).toContain(mine.id);
    expect(idsA).not.toContain(cityB.id);
    const asManagerB = await listShifts(w.cookie.cityManagerB, { limit: "200" });
    expect(asManagerB.json.data.map((row: { id: string }) => row.id)).toContain(cityB.id);

    const everyone = await listShifts(w.cookie.ceo, { limit: "200" });
    expect(everyone.json.data.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([mine.id, cityB.id]));

    const active = await listShifts(w.cookie.ceo, { status: "ACTIVE", employeeId: tech });
    expect(active.json.data.map((row: { id: string }) => row.id)).toEqual([mine.id]);
    const paged = await listShifts(w.cookie.ceo, { limit: "1" });
    expect(paged.json.data).toHaveLength(1);
    expect(paged.json.page.nextCursor).toBeTruthy();
  });

  it("lists shifts waiting for review", async () => {
    await offShift();
    const flagged = (await start(w.cookie.techA1, { exception: { code: "GPS_DISABLED" } })).json.data;
    const pending = await listShifts(w.cookie.cityManagerA, { exceptionReview: "PENDING", limit: "200" });
    expect(pending.json.data.map((row: { id: string }) => row.id)).toContain(flagged.id);
    expect(pending.json.data.every((row: { exceptionReviewStatus: string }) => row.exceptionReviewStatus === "PENDING")).toBe(true);
  });

  it("answers 404 for a shift outside the caller's scope, 403 for roles without shifts.view, and never crosses tenants", async () => {
    await offShift();
    const shift = await startShiftNow();
    expect((await getShift(w.cookie.cityManagerA, shift.id)).status).toBe(200);
    expect((await getShift(w.cookie.cityManagerB, shift.id)).status).toBe(404);
    expect((await getShift(w.cookie.techA1Other, shift.id)).status).toBe(404);
    expect((await getShift(w.cookie.hr, shift.id)).status).toBe(403);
    expect((await listShifts(w.cookie.finance)).status).toBe(403);
    const other = await buildFieldWorld("shifts-other");
    expect((await getShift(other.cookie.ceo, shift.id)).status).toBe(404);
  });
});
