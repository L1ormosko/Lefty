import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFieldEventContent } from "@/lib/location-rules";
import { InvalidStateTransitionError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { runFieldEvent, type FieldEventRequest } from "@/server/field-events";
import { latestValidLocation, purgeExpiredCoordinates, recordLocationEventInTx } from "@/server/location";
import { disconnect } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import type { JobsWorld } from "../jobs/fixtures";
import { buildFieldWorld, storedEvents } from "./fixtures";

let w: JobsWorld;
let employeeId: string;
beforeAll(async () => {
  w = await buildFieldWorld("loc-internals");
  employeeId = w.techA1.employeeId as string;
});
afterAll(disconnect);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const gps = (accuracyM: number) => ({ latitude: 40.5, longitude: -89.5, accuracyM });

/** Writes an event the way a caller module would (a shift is needed for shift kinds, so use a job-less manual kind). */
async function write(overrides: Partial<Parameters<typeof recordLocationEventInTx>[1]> = {}, now = new Date()) {
  return withTenant(w.tenantId, (tx) =>
    recordLocationEventInTx(tx, { tenantId: w.tenantId, employeeId, kind: "VERIFICATION", source: "MANUAL", ...overrides }, now),
  );
}

describe("recordLocationEventInTx", () => {
  it("returns the event without coordinates and says whether it can count as evidence", async () => {
    const good = await write({ source: "DEVICE_GPS", position: gps(20), deviceTime: new Date() });
    expect(good).toMatchObject({ kind: "VERIFICATION", source: "DEVICE_GPS", accuracyM: 20, hasPosition: true, usableAsEvidence: true });
    expect(good).not.toHaveProperty("latitude");
    const vague = await write({ source: "DEVICE_GPS", position: gps(450), deviceTime: new Date() });
    expect(vague.usableAsEvidence).toBe(false); // stored, but never evidence (default max accuracy is 100 m)
    const none = await write({});
    expect(none).toMatchObject({ hasPosition: false, usableAsEvidence: false, accuracyM: null });
  });

  it("stamps the server clock itself and keeps the device clock separate (dual timestamps)", async () => {
    const deviceTime = minutesAgo(3);
    const now = new Date();
    const event = await write({ source: "DEVICE_GPS", position: gps(10), deviceTime }, now);
    expect(event.deviceTime?.getTime()).toBe(deviceTime.getTime());
    expect(event.serverTime.getTime()).toBe(now.getTime());
  });

  it("refuses what the evidence rules forbid, with a client-safe ValidationError", async () => {
    const refused = (overrides: Partial<Parameters<typeof recordLocationEventInTx>[1]>) => expect(write(overrides)).rejects.toBeInstanceOf(ValidationError);
    await refused({ source: "DEVICE_GPS", position: gps(10) }); // no device time
    await refused({ source: "DEVICE_GPS", deviceTime: new Date() }); // no position
    await refused({ source: "MANAGER" }); // no author
    await refused({ source: "DEVICE_GPS", position: { ...gps(10), accuracyM: -1 }, deviceTime: new Date() });
    await refused({ source: "DEVICE_GPS", position: { ...gps(10), longitude: 181 }, deviceTime: new Date() });
    await refused({ kind: "ARRIVAL" }); // job kinds need a job
    await refused({ kind: "SHIFT_START" }); // shift kinds need a shift
    await refused({ exception: "OTHER" });
    await refused({ source: "DEVICE_GPS", position: gps(10), deviceTime: new Date(Date.now() + 3_600_000) });
  });

  it("defaults the org unit to the employee's placement at that moment", async () => {
    const event = await write({});
    const [row] = await storedEvents(w.tenantId, { id: event.id });
    expect(row.orgUnitId).toBe(w.units.teamA1);
  });
});

describe("latestValidLocation (presence helper for arrival and recovery)", () => {
  const options = () => ({ tenantId: w.tenantId, maxAgeMinutes: 30, maxAccuracyM: 100 });
  const find = (id = employeeId, extra: Partial<ReturnType<typeof options>> = {}) => withTenant(w.tenantId, (tx) => latestValidLocation(tx, id, { ...options(), ...extra }));

  it("returns null for an employee with no events", async () => {
    expect(await find(w.techB.employeeId as string)).toBeNull();
  });

  it("returns the newest position that is fresh and accurate, ignoring newer-but-vague ones and old ones", async () => {
    const lone = w.techA1Other.employeeId as string;
    const put = (accuracyM: number, minutes: number) =>
      withTenant(w.tenantId, (tx) =>
        tx.locationEvent.create({
          data: { tenantId: w.tenantId, employeeId: lone, kind: "VERIFICATION", source: "DEVICE_GPS", latitude: 41, longitude: -88, accuracyM, deviceTime: minutesAgo(minutes), serverTime: minutesAgo(minutes) },
        }),
      );
    await put(10, 120); // too old
    expect(await find(lone)).toBeNull();
    const good = await put(30, 10);
    await put(500, 1); // newer but not accurate enough
    const found = await find(lone);
    expect(found).toMatchObject({ locationEventId: good.id, latitude: 41, longitude: -88, accuracyM: 30 });
    expect(await find(lone, { maxAccuracyM: 20 })).toBeNull(); // the tenant's accuracy limit decides
    expect(await find(lone, { maxAgeMinutes: 5 })).toBeNull(); // so does the freshness limit
  });

  it("does not treat an old offline fix synced just now as fresh (the device clock counts too, §26.5)", async () => {
    const lone = w.techB.employeeId as string;
    await withTenant(w.tenantId, (tx) =>
      tx.locationEvent.create({
        data: { tenantId: w.tenantId, employeeId: lone, kind: "VERIFICATION", source: "DEVICE_GPS", latitude: 41, longitude: -88, accuracyM: 10, deviceTime: minutesAgo(6 * 24 * 60), serverTime: minutesAgo(1) },
      }),
    );
    expect(await find(lone)).toBeNull();
  });

  it("ignores positions whose coordinates were purged", async () => {
    const lone = w.techB.employeeId as string;
    await withTenant(w.tenantId, (tx) =>
      tx.locationEvent.create({ data: { tenantId: w.tenantId, employeeId: lone, kind: "VERIFICATION", source: "MANUAL", exception: "GPS_DISABLED", coordinatesPurgedAt: new Date() } }),
    );
    expect(await find(lone)).toBeNull();
  });
});

describe("purgeExpiredCoordinates (retention, spec 22.2)", () => {
  it("removes coordinates of events past the tenant's retention, keeps the rows and everything non-sensitive, and audits", async () => {
    const world = await buildFieldWorld("loc-retention");
    const who = world.techA1.employeeId as string;
    await withTenant(world.tenantId, async (tx) => {
      await tx.operationsSettings.create({ data: { tenantId: world.tenantId, locationRetentionDays: 30 } });
    });
    const make = (days: number) =>
      withTenant(world.tenantId, (tx) =>
        tx.locationEvent.create({
          data: { tenantId: world.tenantId, employeeId: who, kind: "VERIFICATION", source: "DEVICE_GPS", latitude: 40, longitude: -89, accuracyM: 15, deviceTime: new Date(Date.now() - days * 86_400_000), serverTime: new Date(Date.now() - days * 86_400_000) },
        }),
      );
    const old = await make(45);
    const recent = await make(5);

    const result = await purgeExpiredCoordinates(world.tenantId);
    expect(result.purged).toBe(1);

    const rows = await withTenant(world.tenantId, (tx) => tx.locationEvent.findMany({ where: { id: { in: [old.id, recent.id] } } }));
    const purged = rows.find((row) => row.id === old.id)!;
    expect(purged.latitude).toBeNull();
    expect(purged.longitude).toBeNull();
    expect(purged.coordinatesPurgedAt).not.toBeNull();
    expect(purged).toMatchObject({ accuracyM: 15, kind: "VERIFICATION" });
    expect(rows.find((row) => row.id === recent.id)?.latitude).not.toBeNull();

    expect((await purgeExpiredCoordinates(world.tenantId)).purged).toBe(0); // idempotent
    const [audit] = await auditEvents(world.tenantId, "location.purge_coordinates");
    expect(audit.actorUserId).toBeNull();
    expect(audit.newValue).toMatchObject({ purged: 1, retentionDays: 30 });
  });

  it("uses 90 days when the tenant has no settings and never touches another tenant", async () => {
    const mine = await buildFieldWorld("loc-retention-a");
    const theirs = await buildFieldWorld("loc-retention-b");
    const make = (world: JobsWorld) =>
      withTenant(world.tenantId, (tx) =>
        tx.locationEvent.create({
          data: { tenantId: world.tenantId, employeeId: world.techA1.employeeId as string, kind: "VERIFICATION", source: "DEVICE_GPS", latitude: 40, longitude: -89, accuracyM: 15, deviceTime: new Date(Date.now() - 100 * 86_400_000), serverTime: new Date(Date.now() - 100 * 86_400_000) },
        }),
      );
    const myEvent = await make(mine);
    const theirEvent = await make(theirs);
    expect((await purgeExpiredCoordinates(mine.tenantId)).purged).toBe(1);
    expect((await withTenant(theirs.tenantId, (tx) => tx.locationEvent.findFirstOrThrow({ where: { id: theirEvent.id } }))).latitude).not.toBeNull();
    expect((await withTenant(mine.tenantId, (tx) => tx.locationEvent.findFirstOrThrow({ where: { id: myEvent.id } }))).latitude).toBeNull();
  });
});

describe("runFieldEvent (the offline gate)", () => {
  const request = (clientEventId: string, content: unknown = { n: 1 }): FieldEventRequest => ({
    tenantId: w.tenantId,
    employeeId,
    actorUserId: w.techA1.userId,
    type: "test.event",
    clientEventId,
    occurredAt: new Date(),
    payloadHash: hashFieldEventContent(content),
  });
  const counting = () => {
    let applied = 0;
    return {
      applied: () => applied,
      handlers: {
        apply: async () => {
          applied += 1;
          return { result: `done-${applied}`, entity: { type: "Thing", id: "thing-1" } };
        },
        replay: async () => "replayed",
      },
    };
  };

  it("applies once for two concurrent deliveries of the same event", async () => {
    const id = randomUUID();
    const work = counting();
    const [first, second] = await Promise.all([runFieldEvent(request(id), work.handlers), runFieldEvent(request(id), work.handlers)]);
    expect(work.applied()).toBe(1);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  });

  it("stores a business refusal as REJECTED and refuses the replay identically, without running the work again", async () => {
    const id = randomUUID();
    let runs = 0;
    const failing = {
      apply: async () => {
        runs += 1;
        throw new InvalidStateTransitionError({ message: "No active shift" });
      },
      replay: async () => "never",
    };
    await expect(runFieldEvent(request(id), failing)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(runFieldEvent(request(id), failing)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(runs).toBe(1);
    const [row] = await withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { tenantId: w.tenantId, clientEventId: id } }));
    expect(row).toMatchObject({ result: "REJECTED", resultCode: "INVALID_STATE_TRANSITION" });
  });

  it("keys idempotency per employee: the same clientEventId from two employees is two separate events", async () => {
    const id = randomUUID();
    const work = counting();
    const other: FieldEventRequest = { ...request(id), employeeId: w.techA1Other.employeeId as string, actorUserId: w.techA1Other.userId };
    const [mine, theirs] = await Promise.all([runFieldEvent(request(id), work.handlers), runFieldEvent(other, work.handlers)]);
    expect([mine.replayed, theirs.replayed]).toEqual([false, false]);
    expect(work.applied()).toBe(2);
    expect(await withTenant(w.tenantId, (tx) => tx.fieldEvent.count({ where: { tenantId: w.tenantId, clientEventId: id } }))).toBe(2);
  });

  it("rolls the claim back on an unexpected failure so a retry can succeed", async () => {
    const id = randomUUID();
    await expect(runFieldEvent(request(id), { apply: async () => Promise.reject(new Error("boom")), replay: async () => "x" })).rejects.toThrow("boom");
    expect(await withTenant(w.tenantId, (tx) => tx.fieldEvent.count({ where: { tenantId: w.tenantId, clientEventId: id } }))).toBe(0);
    const work = counting();
    expect((await runFieldEvent(request(id), work.handlers)).replayed).toBe(false);
  });

  it("refuses a payload that contains coordinates (they must stay in LocationEvent)", async () => {
    await expect(runFieldEvent({ ...request(randomUUID()), payload: { where: { latitude: 1 } } }, counting().handlers)).rejects.toThrow(/coordinates/);
  });
});
