import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import type { JobsWorld } from "../jobs/fixtures";
import { assignedJobFor, buildFieldWorld, getEvent, listEvents, position, record, storedEvents } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildFieldWorld("loc-events");
});
afterAll(disconnect);

const jobStatus = async (jobId: string) => (await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId }, select: { status: true } }))).status;

describe("a technician reporting a location event (POST /location-events)", () => {
  it("stores the position with accuracy, both clocks and source, and never echoes coordinates", async () => {
    const jobId = await assignedJobFor(w);
    const deviceTime = new Date(Date.now() - 30_000).toISOString();
    const response = await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId, position: position({ deviceTime }) });
    expect(response.status).toBe(201);
    expect(response.json.data).toMatchObject({ kind: "NAVIGATION_OPENED", source: "DEVICE_GPS", accuracyM: 13, verification: "UNVERIFIED", employeeId: w.techA1.employeeId, jobId });
    expect(response.json.data).not.toHaveProperty("latitude");
    expect(response.json.data).not.toHaveProperty("longitude");
    expect(new Date(response.json.data.deviceTime).toISOString()).toBe(deviceTime);
    expect(response.json.data.serverTime).toBeTruthy();

    const [row] = await storedEvents(w.tenantId, { id: response.json.data.id });
    expect(Number(row.latitude)).toBe(40);
    expect(row.accuracyM).toBe(13); // rounded UP: never claims better than reported
    expect(row.orgUnitId).toBe(w.units.teamA1);
  });

  it("never changes the job status or counts as arrival (navigation opened is informational, spec 8.3)", async () => {
    const jobId = await assignedJobFor(w);
    const before = await jobStatus(jobId);
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId, position: position() })).status).toBe(201);
    expect(await jobStatus(jobId)).toBe(before);
    const job = await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId }, select: { arrivedAt: true, enRouteAt: true } }));
    expect(job).toEqual({ arrivedAt: null, enRouteAt: null });
    expect(await withTenant(w.tenantId, (tx) => tx.arrivalVerification.count({ where: { jobId } }))).toBe(0);
  });

  it("accepts a navigation event with neither position nor reason, but a departure must have one", async () => {
    const jobId = await assignedJobFor(w);
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId })).status).toBe(201);
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId })).status).toBe(400);
    const manual = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, exception: { code: "GPS_DISABLED", note: "Phone location is off" } });
    expect(manual.status).toBe(201);
    expect(manual.json.data).toMatchObject({ source: "MANUAL", exception: "GPS_DISABLED", accuracyM: null });
  });

  it("refuses a position without accuracy, an out-of-range latitude and OTHER without an explanation", async () => {
    const jobId = await assignedJobFor(w);
    const { accuracyM: _omit, ...noAccuracy } = position();
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: noAccuracy })).status).toBe(400);
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: position({ latitude: 91 }) })).status).toBe(400);
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, exception: { code: "OTHER" } })).status).toBe(400);
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: position(), exception: { code: "POOR_SIGNAL" } })).status).toBe(400);
  });

  it("refuses kinds that belong to other flows and a device time in the future", async () => {
    const jobId = await assignedJobFor(w);
    expect((await record(w.cookie.techA1, { kind: "ARRIVAL", jobId, position: position() })).status).toBe(400);
    expect((await record(w.cookie.techA1, { kind: "SHIFT_START", jobId, position: position() })).status).toBe(400);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: position({ deviceTime: future }) })).status).toBe(400);
  });

  it("only works for a job assigned to the caller (404 otherwise) and writes an audit event without coordinates", async () => {
    const jobId = await assignedJobFor(w);
    expect((await record(w.cookie.techA1Other, { kind: "NAVIGATION_OPENED", jobId, position: position() })).status).toBe(404);
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId: "does-not-exist", position: position() })).status).toBe(404);

    const response = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: position() });
    const [audit] = await auditEvents(w.tenantId, "location.record", response.json.data.id);
    expect(audit.actorUserId).toBe(w.techA1.userId);
    expect(JSON.stringify(audit.newValue)).not.toMatch(/latitude|longitude|40\.0|-89/);
    expect(audit.newValue).toMatchObject({ kind: "DEPARTURE", hasPosition: true, accuracyM: 13 });
  });

  it("is refused to people without location.create (manager) and to unauthenticated callers", async () => {
    const jobId = await assignedJobFor(w);
    expect((await record(w.cookie.cityManagerA, { kind: "NAVIGATION_OPENED", jobId })).status).toBe(403);
    expect((await record("", { kind: "NAVIGATION_OPENED", jobId })).status).toBe(401);
  });
});

describe("offline idempotency (clientEventId)", () => {
  it("applies a repeated delivery once and answers with the original event", async () => {
    const jobId = await assignedJobFor(w);
    const body = { kind: "DEPARTURE", jobId, clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 600_000).toISOString(), position: position({ deviceTime: new Date(Date.now() - 600_000).toISOString() }) };
    const first = await record(w.cookie.techA1, body);
    const second = await record(w.cookie.techA1, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(await storedEvents(w.tenantId, { jobId, kind: "DEPARTURE" })).toHaveLength(1);

    const logged = await withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { tenantId: w.tenantId, clientEventId: body.clientEventId } }));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ result: "ACCEPTED", type: "location.departure", entityType: "LocationEvent", entityId: first.json.data.id, employeeId: w.techA1.employeeId });
    expect(logged[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(logged[0].payload)).not.toMatch(/latitude|longitude/);
  });

  it("answers 409 when the same clientEventId is reused for different content", async () => {
    const jobId = await assignedJobFor(w);
    const clientEventId = randomUUID();
    expect((await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, clientEventId, position: position({ latitude: 40 }) })).status).toBe(201);
    const moved = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, clientEventId, position: position({ latitude: 41 }) });
    expect(moved.status).toBe(409);
    expect(moved.json.error.details?.[0]?.code).toBe("CLIENT_EVENT_ID_REUSED");
    expect(await storedEvents(w.tenantId, { jobId, kind: "DEPARTURE" })).toHaveLength(1);
  });

  it("keys idempotency per employee: another technician's identical id is a separate event", async () => {
    const jobId = await assignedJobFor(w);
    const clientEventId = randomUUID();
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId, clientEventId })).status).toBe(201);
    // techA1Other cannot see the job (404) - the id of another employee never collides or leaks.
    expect((await record(w.cookie.techA1Other, { kind: "NAVIGATION_OPENED", jobId, clientEventId })).status).toBe(404);
  });

  it("keeps the device time of a manual event (occurredAt) and refuses occurredAt that disagrees with the position's device time", async () => {
    const jobId = await assignedJobFor(w);
    const happened = new Date(Date.now() - 2 * 3_600_000);
    const manual = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, occurredAt: happened.toISOString(), exception: { code: "DEVICE_OFFLINE" } });
    expect(manual.status).toBe(201);
    expect(new Date(manual.json.data.deviceTime).toISOString()).toBe(happened.toISOString());

    const apart = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, occurredAt: happened.toISOString(), position: position({ deviceTime: new Date().toISOString() }) });
    expect(apart.status).toBe(400);
    expect(apart.json.error.field).toBe("occurredAt");
    const agreeing = await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, occurredAt: happened.toISOString(), position: position({ deviceTime: new Date(happened.getTime() + 60_000).toISOString() }) });
    expect(agreeing.status).toBe(201);
  });

  it("refuses an occurredAt far in the future and a malformed clientEventId", async () => {
    const jobId = await assignedJobFor(w);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId, clientEventId: randomUUID(), occurredAt: future })).status).toBe(400);
    expect((await record(w.cookie.techA1, { kind: "NAVIGATION_OPENED", jobId, clientEventId: "not-a-uuid" })).status).toBe(400);
  });
});

describe("reading location history (sensitive, spec 17 / 22.2)", () => {
  let eventId: string;
  let otherUnitEventId: string;
  beforeAll(async () => {
    const jobId = await assignedJobFor(w);
    eventId = (await record(w.cookie.techA1, { kind: "DEPARTURE", jobId, position: position({ latitude: 40.123456, longitude: -89.654321 }) })).json.data.id;
    // A technician in City B (techB) has events too: City Manager A must not see them.
    await withTenant(w.tenantId, async (tx) => {
      const row = await tx.locationEvent.create({
        data: { tenantId: w.tenantId, employeeId: w.techB.employeeId as string, orgUnitId: w.units.cityB, kind: "NAVIGATION_OPENED", source: "MANUAL", jobId: (await tx.job.findFirstOrThrow({ where: { tenantId: w.tenantId }, select: { id: true } })).id },
      });
      otherUnitEventId = row.id;
    });
  });

  it("gives the Owner coordinates, the manager accuracy and verdicts without them", async () => {
    const owner = await getEvent(w.cookie.ceo, eventId);
    expect(owner.status).toBe(200);
    expect(owner.json.data).toMatchObject({ latitude: 40.123456, longitude: -89.654321, accuracyM: 13, kind: "DEPARTURE" });

    const manager = await getEvent(w.cookie.cityManagerA, eventId);
    expect(manager.status).toBe(200);
    expect(manager.json.data).toMatchObject({ accuracyM: 13, kind: "DEPARTURE", verification: "UNVERIFIED" });
    expect(manager.json.data).not.toHaveProperty("latitude");
    expect(manager.json.data).not.toHaveProperty("longitude");
    expect(JSON.stringify(manager.json)).not.toMatch(/40\.1234|89\.6543/);
  });

  it("lists scope-filtered events: a manager sees their unit's people only, never positions", async () => {
    const asManager = await listEvents(w.cookie.cityManagerA, { employeeId: w.techA1.employeeId as string });
    expect(asManager.status).toBe(200);
    expect(asManager.json.data.length).toBeGreaterThan(0);
    for (const row of asManager.json.data) {
      expect(row.employeeId).toBe(w.techA1.employeeId);
      expect(row).not.toHaveProperty("latitude");
    }
    const all = await listEvents(w.cookie.cityManagerA);
    expect(all.json.data.map((row: { id: string }) => row.id)).not.toContain(otherUnitEventId);
    expect((await getEvent(w.cookie.cityManagerA, otherUnitEventId)).status).toBe(404);

    const everything = await listEvents(w.cookie.ceo, { limit: "200" });
    expect(everything.json.data.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([eventId, otherUnitEventId]));
    expect(everything.json.data.find((row: { id: string }) => row.id === eventId)).toHaveProperty("latitude", 40.123456);
  });

  it("filters by kind and time and pages with a cursor", async () => {
    const departures = await listEvents(w.cookie.ceo, { kind: "DEPARTURE", limit: "1" });
    expect(departures.json.data).toHaveLength(1);
    expect(departures.json.data[0].kind).toBe("DEPARTURE");
    expect(departures.json.page.nextCursor).toBeTruthy();
    const next = await listEvents(w.cookie.ceo, { kind: "DEPARTURE", limit: "1", cursor: departures.json.page.nextCursor });
    expect(next.json.data[0].id).not.toBe(departures.json.data[0].id);
    const future = await listEvents(w.cookie.ceo, { from: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.json.data).toEqual([]);
  });

  it("is refused to those without location.view: technician (no history of their own), dispatcher, HR, finance", async () => {
    for (const cookie of [w.cookie.techA1, w.cookie.dispatcher, w.cookie.hr, w.cookie.finance]) {
      expect((await listEvents(cookie)).status).toBe(403);
      expect((await getEvent(cookie, eventId)).status).toBe(403);
    }
  });

  it("does not leak across tenants", async () => {
    const other = await buildFieldWorld("loc-events-other");
    expect((await getEvent(other.cookie.ceo, eventId)).status).toBe(404);
    const theirs = await listEvents(other.cookie.ceo, { limit: "200" });
    expect(theirs.json.data.map((row: { id: string }) => row.id)).not.toContain(eventId);
  });
});
