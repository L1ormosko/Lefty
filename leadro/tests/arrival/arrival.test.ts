import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import type { JobsWorld } from "../jobs/fixtures";
import { auditEvents } from "../org/org-helpers";
import {
  SITE,
  arrive,
  backdateStatus,
  buildArrivalWorld,
  enRouteJob,
  jobRow,
  listArrivals,
  move,
  navigationOpened,
  newClientEventId,
  positionNear,
  scheduleJob,
  scheduledJobFor,
  setAddress,
  startWork,
  storedArrivals,
  storedLocationEvents,
  verify,
} from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildArrivalWorld("arrival");
});
afterAll(disconnect);

const containsCoordinates = (value: unknown): boolean => /"(latitude|longitude)"/.test(JSON.stringify(value));

describe("confirming arrival (POST /jobs/{id}/arrive)", () => {
  it("inside the radius: records a candidate verification with distance, accuracy and radius, moves the job to ARRIVED, returns no coordinates", async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { position: positionNear() });
    expect(response.status).toBe(201);
    expect(response.json.data.job).toMatchObject({ id: jobId, status: "ARRIVED" });
    expect(response.json.data.arrival).toMatchObject({
      status: "RECORDED",
      method: "TECHNICIAN",
      confidence: "WITHIN_RADIUS_REPORTED",
      geofenceRadiusM: 150,
      accuracyM: 10,
      employeeId: w.techA1.employeeId,
      exceptionReason: null,
    });
    expect(response.json.data.arrival.distanceToJobM).toBeGreaterThan(10);
    expect(response.json.data.arrival.distanceToJobM).toBeLessThan(30);
    expect(containsCoordinates(response.json)).toBe(false);

    expect((await jobRow(w, jobId)).status).toBe("ARRIVED");
    const [event] = (await storedLocationEvents(w, jobId)).filter((row) => row.kind === "ARRIVAL");
    expect(event).toMatchObject({ source: "DEVICE_GPS", verification: "WITHIN_RADIUS", accuracyM: 10, geofenceRadiusM: 150 });
    expect(event.deviceTime).toBeTruthy();
    expect(Number(event.latitude)).toBeCloseTo(SITE.latitude, 3); // coordinates live only in the location event
    const audits = await auditEvents(w.tenantId, "arrival.record", response.json.data.arrival.id);
    expect(containsCoordinates(audits)).toBe(false);
  });

  it("outside the radius: still ARRIVED, but PENDING_MANAGER_REVIEW with an OUTSIDE_GEOFENCE exception, and the manager is told", async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { position: positionNear({}, 2_000) });
    expect(response.status).toBe(201);
    expect(response.json.data.job.status).toBe("ARRIVED");
    expect(response.json.data.arrival).toMatchObject({ status: "PENDING_MANAGER_REVIEW", exceptionReason: "OUTSIDE_GEOFENCE", confidence: "NEEDS_MANAGER_REVIEW" });
    expect(response.json.data.arrival.distanceToJobM).toBeGreaterThan(1_900);
    const [event] = (await storedLocationEvents(w, jobId)).filter((row) => row.kind === "ARRIVAL");
    expect(event.verification).toBe("OUTSIDE_RADIUS");
    const notified = await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { tenantId: w.tenantId, eventType: "job.arrival_unverified" } }));
    expect(notified).toBeGreaterThan(0);
  });

  it("uses the address's own radius over the tenant default", async () => {
    await setAddress(w, { latitude: SITE.latitude, longitude: SITE.longitude, geofenceRadiusM: 3_000 });
    try {
      const jobId = await enRouteJob(w);
      const response = await arrive(w.cookie.techA1, jobId, { position: positionNear({}, 2_000) });
      expect(response.json.data.arrival).toMatchObject({ status: "RECORDED", geofenceRadiusM: 3_000, confidence: "WITHIN_RADIUS_REPORTED" });
    } finally {
      await setAddress(w, { latitude: SITE.latitude, longitude: SITE.longitude, geofenceRadiusM: null });
    }
  });

  it("never confirms with a vague fix: it is recorded with its accuracy and sent to a manager", async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { position: positionNear({ accuracyM: 900 }) });
    expect(response.json.data.arrival).toMatchObject({ status: "PENDING_MANAGER_REVIEW", exceptionReason: "POOR_SIGNAL", accuracyM: 900 });
  });

  it("without a position the technician says why, and a manager verifies", async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { exception: { code: "GPS_DISABLED" }, occurredAt: new Date(Date.now() - 60_000).toISOString() });
    expect(response.status).toBe(201);
    expect(response.json.data.arrival).toMatchObject({ status: "PENDING_MANAGER_REVIEW", exceptionReason: "GPS_DISABLED", distanceToJobM: null });
    const [event] = (await storedLocationEvents(w, jobId)).filter((row) => row.kind === "ARRIVAL");
    expect(event).toMatchObject({ source: "MANUAL", latitude: null, exception: "GPS_DISABLED" });
  });

  it("flags an address without coordinates instead of guessing", async () => {
    await setAddress(w, { latitude: null, longitude: null, geofenceRadiusM: null });
    try {
      const jobId = await enRouteJob(w);
      const response = await arrive(w.cookie.techA1, jobId, { position: positionNear() });
      expect(response.json.data.arrival).toMatchObject({ status: "PENDING_MANAGER_REVIEW", exceptionReason: "OTHER", distanceToJobM: null });
    } finally {
      await setAddress(w, { latitude: SITE.latitude, longitude: SITE.longitude, geofenceRadiusM: null });
    }
  });

  it("records a geofence-triggered arrival with the GEOFENCE source and method", async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { trigger: "GEOFENCE", position: positionNear() });
    expect(response.json.data.arrival).toMatchObject({ method: "GEOFENCE", status: "RECORDED" });
    expect((await storedLocationEvents(w, jobId)).find((row) => row.kind === "ARRIVAL")?.source).toBe("GEOFENCE");
  });

  it("refuses bad requests: no position and no reason, both, a geofence event without a position", async () => {
    const jobId = await enRouteJob(w);
    expect((await arrive(w.cookie.techA1, jobId, {})).status).toBe(400);
    expect((await arrive(w.cookie.techA1, jobId, { position: positionNear(), exception: { code: "POOR_SIGNAL" } })).status).toBe(400);
    expect((await arrive(w.cookie.techA1, jobId, { trigger: "GEOFENCE", exception: { code: "POOR_SIGNAL" } })).status).toBe(400);
    expect((await arrive(w.cookie.techA1, jobId, { position: { latitude: 40, longitude: -89, deviceTime: new Date().toISOString() } })).status).toBe(400); // accuracy is mandatory
    expect((await jobRow(w, jobId)).status).toBe("EN_ROUTE");
  });

  it("only works for an assigned technician on an EN_ROUTE job", async () => {
    const jobId = await enRouteJob(w);
    expect((await arrive(w.cookie.techA1Other, jobId, { position: positionNear() })).status).toBe(404);
    expect((await arrive(w.cookie.dispatcher, jobId, { position: positionNear() })).status).toBe(403); // not an employee in the field
    expect((await arrive(w.cookie.techA1, jobId, { position: positionNear() })).status).toBe(201);
    const again = await arrive(w.cookie.techA1, jobId, { position: positionNear() });
    expect(again.status).toBe(409); // already ARRIVED
    expect(await storedArrivals(w, jobId)).toHaveLength(1);
  });

  it("is idempotent per clientEventId (offline replays) and refuses a reused id with different content", async () => {
    const jobId = await enRouteJob(w);
    const clientEventId = newClientEventId();
    const body = { clientEventId, position: positionNear() };
    const first = await arrive(w.cookie.techA1, jobId, body);
    const replay = await arrive(w.cookie.techA1, jobId, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.json.data.arrival.id).toBe(first.json.data.arrival.id);
    expect(await storedArrivals(w, jobId)).toHaveLength(1);

    const conflict = await arrive(w.cookie.techA1, jobId, { clientEventId, position: positionNear({}, 5_000) });
    expect(conflict.status).toBe(409);
  });

  it("keeps the device time of an offline arrival", async () => {
    const jobId = await enRouteJob(w);
    await backdateStatus(w, jobId, 60);
    const arrivedAt = new Date(Date.now() - 20 * 60_000);
    const response = await arrive(w.cookie.techA1, jobId, { clientEventId: newClientEventId(), occurredAt: arrivedAt.toISOString(), position: positionNear({ deviceTime: arrivedAt.toISOString() }) });
    expect(new Date(response.json.data.arrival.arrivedAt).toISOString()).toBe(arrivedAt.toISOString());
    expect((await arrive(w.cookie.techA1, await enRouteJob(w), { occurredAt: new Date(Date.now() + 3_600_000).toISOString(), exception: { code: "DELAYED" } })).status).toBe(400);
  });

  it("cannot be shortcut with a plain status transition by the technician", async () => {
    const jobId = await enRouteJob(w);
    expect((await move(w.cookie.techA1, jobId, "ARRIVED")).status).toBe(403);
    expect((await move(w.cookie.techA1, jobId, "IN_PROGRESS")).status).toBe(403);
  });
});

describe("navigation opened (POST /jobs/{id}/navigation-opened)", () => {
  it("records the event without changing the job or creating an arrival", async () => {
    const jobId = await enRouteJob(w);
    const response = await navigationOpened(w.cookie.techA1, jobId, { position: positionNear() });
    expect(response.status).toBe(201);
    expect(response.json.data).toMatchObject({ kind: "NAVIGATION_OPENED", jobId });
    expect(containsCoordinates(response.json)).toBe(false);
    expect((await jobRow(w, jobId)).status).toBe("EN_ROUTE");
    expect(await storedArrivals(w, jobId)).toHaveLength(0);
  });

  it("is idempotent per clientEventId and refuses a job that is not the caller's", async () => {
    const jobId = await enRouteJob(w);
    const body = { clientEventId: newClientEventId() };
    expect((await navigationOpened(w.cookie.techA1, jobId, body)).status).toBe(201);
    expect((await navigationOpened(w.cookie.techA1, jobId, body)).status).toBe(200);
    expect((await navigationOpened(w.cookie.techA1Other, jobId, {})).status).toBe(404);
  });
});

describe("start work (POST /jobs/{id}/start-work)", () => {
  it("moves ARRIVED to IN_PROGRESS and stamps startedAt; not before arrival", async () => {
    const jobId = await enRouteJob(w);
    expect((await startWork(w.cookie.techA1, jobId)).status).toBe(409);
    await arrive(w.cookie.techA1, jobId, { position: positionNear() });
    const started = await startWork(w.cookie.techA1, jobId);
    expect(started.status).toBe(200);
    expect(started.json.data.job).toMatchObject({ id: jobId, status: "IN_PROGRESS" });
    expect(started.json.data.job.startedAt).toBeTruthy();
    expect((await jobRow(w, jobId)).startedAt).not.toBeNull();
    expect((await startWork(w.cookie.techA1, jobId)).status).toBe(409); // already started
  });

  it("is idempotent per clientEventId and honors the device time (never before the arrival)", async () => {
    const jobId = await enRouteJob(w);
    await backdateStatus(w, jobId, 60);
    const arrivedAt = new Date(Date.now() - 30 * 60_000);
    await arrive(w.cookie.techA1, jobId, { occurredAt: arrivedAt.toISOString(), position: positionNear({ deviceTime: arrivedAt.toISOString() }) });
    const clientEventId = newClientEventId();
    const early = new Date(Date.now() - 45 * 60_000).toISOString();
    const first = await startWork(w.cookie.techA1, jobId, { clientEventId, occurredAt: early });
    const replay = await startWork(w.cookie.techA1, jobId, { clientEventId, occurredAt: early });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json.data.job.status).toBe("IN_PROGRESS");
    expect(new Date((await jobRow(w, jobId)).startedAt!).getTime()).toBe(arrivedAt.getTime());
    expect((await startWork(w.cookie.techA1, jobId, { clientEventId, occurredAt: new Date().toISOString() })).status).toBe(409);
  });

  it("is refused for someone else's job (404) and leaves the job ARRIVED", async () => {
    const jobId = await enRouteJob(w);
    await arrive(w.cookie.techA1, jobId, { position: positionNear() });
    expect((await startWork(w.cookie.techA1Other, jobId)).status).toBe(404);
    expect((await startWork(w.cookie.dispatcher, jobId)).status).toBe(404); // not their job, even with jobs.edit
    expect((await jobRow(w, jobId)).status).toBe("ARRIVED");
  });
});

describe("manager verification (POST /jobs/{id}/arrivals/{arrivalId}/verify)", () => {
  const pendingArrival = async () => {
    const jobId = await enRouteJob(w);
    const response = await arrive(w.cookie.techA1, jobId, { position: positionNear({}, 2_000) });
    return { jobId, arrivalId: response.json.data.arrival.id as string };
  };

  it("lets a manager verify with a reason: recorded, audited, and a VERIFICATION location event is added", async () => {
    const { jobId, arrivalId } = await pendingArrival();
    const done = await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "VERIFIED", note: "Customer confirmed the technician is on site." });
    expect(done.status).toBe(200);
    expect(done.json.data).toMatchObject({ status: "MANAGER_VERIFIED", confidence: "MANAGER_VERIFIED", verificationNote: "Customer confirmed the technician is on site." });
    expect(done.json.data.verifiedByUserId).toBeTruthy();
    expect(containsCoordinates(done.json)).toBe(false);
    expect((await storedLocationEvents(w, jobId)).filter((row) => row.kind === "VERIFICATION")).toMatchObject([{ source: "MANAGER", verification: "MANAGER_VERIFIED" }]);
    expect((await auditEvents(w.tenantId, "arrival.verify", arrivalId)).length).toBe(1);
    expect((await startWork(w.cookie.techA1, jobId)).status).toBe(200);
  });

  it("rejecting keeps the job where it is but blocks start work", async () => {
    const { jobId, arrivalId } = await pendingArrival();
    const done = await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "REJECTED", note: "The technician was at the wrong address." });
    expect(done.json.data).toMatchObject({ status: "MANAGER_REJECTED", confidence: "MANAGER_REJECTED" });
    expect((await jobRow(w, jobId)).status).toBe("ARRIVED");
    expect((await storedLocationEvents(w, jobId)).filter((row) => row.kind === "VERIFICATION")).toHaveLength(0);
    expect((await startWork(w.cookie.techA1, jobId)).status).toBe(409);
  });

  it("decides once, needs a reason, and belongs to managers of the job's unit only", async () => {
    const { jobId, arrivalId } = await pendingArrival();
    expect((await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "VERIFIED" })).status).toBe(400);
    expect((await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "VERIFIED", note: "   " })).status).toBe(400);
    expect((await verify(w.cookie.techA1, jobId, arrivalId, { decision: "VERIFIED", note: "me" })).status).toBe(403);
    expect([403, 404]).toContain((await verify(w.cookie.cityManagerB, jobId, arrivalId, { decision: "VERIFIED", note: "not mine" })).status);
    expect((await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "VERIFIED", note: "ok" })).status).toBe(200);
    expect((await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "REJECTED", note: "changed my mind" })).status).toBe(409);
    expect((await verify(w.cookie.cityManagerA, jobId, "no-such-arrival", { decision: "VERIFIED", note: "x" })).status).toBe(404);
  });

  it("can also override an arrival the server had accepted, with a reason", async () => {
    const jobId = await enRouteJob(w);
    const arrivalId = (await arrive(w.cookie.techA1, jobId, { position: positionNear() })).json.data.arrival.id as string;
    const done = await verify(w.cookie.cityManagerA, jobId, arrivalId, { decision: "REJECTED", note: "GPS spoofing suspected by the customer." });
    expect(done.json.data.status).toBe("MANAGER_REJECTED");
  });
});

describe("listing arrivals (GET /jobs/{id}/arrivals)", () => {
  it("shows managers the arrivals with confidence and no coordinates, and hides the job from others", async () => {
    const jobId = await enRouteJob(w);
    await arrive(w.cookie.techA1, jobId, { position: positionNear({}, 2_000) });
    const listed = await listArrivals(w.cookie.cityManagerA, jobId);
    expect(listed.status).toBe(200);
    expect(listed.json.data).toHaveLength(1);
    expect(listed.json.data[0]).toMatchObject({ status: "PENDING_MANAGER_REVIEW", confidence: "NEEDS_MANAGER_REVIEW" });
    expect(containsCoordinates(listed.json)).toBe(false);
    expect([403, 404]).toContain((await listArrivals(w.cookie.cityManagerB, jobId)).status);
  });
});

describe("device clocks and ordering (offline)", () => {
  it("never stores an arrival or work start later than the server clock, even when the device runs a few minutes ahead", async () => {
    const jobId = await enRouteJob(w);
    const ahead = new Date(Date.now() + 3 * 60_000).toISOString();
    const arrived = await arrive(w.cookie.techA1, jobId, { occurredAt: ahead, position: positionNear({ deviceTime: ahead }) });
    expect(arrived.status).toBe(201);
    expect(new Date(arrived.json.data.arrival.arrivedAt).getTime()).toBeLessThanOrEqual(Date.now());
    const started = await startWork(w.cookie.techA1, jobId, { occurredAt: ahead });
    expect(started.status).toBe(200);
    expect(new Date(started.json.data.job.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await startWork(w.cookie.techA1, await enRouteJob(w), { occurredAt: new Date(Date.now() + 10 * 60_000).toISOString() })).status).toBe(400);
  });

  it("does not let an arrival predate the moment the job went EN_ROUTE", async () => {
    const jobId = await enRouteJob(w);
    const early = new Date(Date.now() - 3 * 3_600_000);
    const arrived = await arrive(w.cookie.techA1, jobId, { occurredAt: early.toISOString(), position: positionNear({ deviceTime: early.toISOString() }) });
    expect(new Date(arrived.json.data.arrival.arrivedAt).getTime()).toBeGreaterThan(Date.now() - 120_000);
  });

  it("does not store an ordering refusal: the same clientEventId succeeds once the earlier event has synced", async () => {
    const jobId = await scheduledJobFor(w);
    const arriveId = newClientEventId();
    const body = { clientEventId: arriveId, position: positionNear() };
    const tooEarly = await arrive(w.cookie.techA1, jobId, body);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.json.error.retryable).toBe(true);
    expect((await move(w.cookie.techA1, jobId, "EN_ROUTE")).status).toBe(200);
    expect((await arrive(w.cookie.techA1, jobId, body)).status).toBe(201);

    const startId = newClientEventId();
    const other = await enRouteJob(w);
    expect((await startWork(w.cookie.techA1, other, { clientEventId: startId })).status).toBe(409); // not arrived yet
    expect((await arrive(w.cookie.techA1, other, { position: positionNear() })).status).toBe(201);
    expect((await startWork(w.cookie.techA1, other, { clientEventId: startId })).status).toBe(200);
  });

  it("re-checks access when a start-work is replayed", async () => {
    const jobId = await enRouteJob(w);
    await arrive(w.cookie.techA1, jobId, { position: positionNear() });
    const body = { clientEventId: newClientEventId() };
    expect((await startWork(w.cookie.techA1, jobId, body)).status).toBe(200);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.updateMany({ where: { tenantId: w.tenantId, jobId }, data: { state: "ENDED", endedAt: new Date() } }));
    expect((await startWork(w.cookie.techA1, jobId, body)).status).toBe(404);
  });

  it("judges a later visit by its own arrival: an old visit's rejected arrival does not block the new visit", async () => {
    const jobId = await enRouteJob(w);
    const first = (await arrive(w.cookie.techA1, jobId, { position: positionNear({}, 2_000) })).json.data.arrival.id as string;
    expect((await verify(w.cookie.cityManagerA, jobId, first, { decision: "REJECTED", note: "Wrong address." })).status).toBe(200);
    expect((await move(w.cookie.dispatcher, jobId, "CUSTOMER_UNAVAILABLE", "Nobody home")).status).toBe(200);
    await scheduleJob(w, jobId); // CUSTOMER_UNAVAILABLE + a slot = SCHEDULED again
    expect((await move(w.cookie.techA1, jobId, "EN_ROUTE")).status).toBe(200);
    expect((await arrive(w.cookie.techA1, jobId, { position: positionNear() })).status).toBe(201);
    expect((await startWork(w.cookie.techA1, jobId)).status).toBe(200);
    expect((await storedArrivals(w, jobId)).map((row) => row.status)).toEqual(["MANAGER_REJECTED", "RECORDED"]);
  });
});
