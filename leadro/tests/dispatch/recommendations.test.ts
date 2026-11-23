import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { auditEvents } from "../org/org-helpers";
import { createJobViaApi } from "../jobs/fixtures";
import { buildDispatchWorld, candidates, generate, listFor, read, type DispatchWorld } from "./fixtures";

let w: DispatchWorld;
beforeAll(async () => {
  w = await buildDispatchWorld("dispatch-rank");
});
afterAll(disconnect);

const inspectionJob = (body: Record<string, unknown> = {}) => createJobViaApi(w, { ...w.inspectionBody, ...body });

describe("generating a recommendation", () => {
  it("ranks the eligible employees by soft factors, explains every factor and changes nothing on the job", async () => {
    const job = await inspectionJob();
    const response = await generate(w.cookie.dispatcher, job.id);
    expect(response.status).toBe(201);
    const rec = response.json.data;
    expect(rec).toMatchObject({ jobId: job.id, mode: "AI_ASSISTED", status: "PENDING", blockingReasons: null, distanceBasis: "STRAIGHT_LINE_ESTIMATE", decidedAt: null });

    const [first, second] = rec.candidates;
    expect(first).toMatchObject({ employeeId: w.techA1.employeeId, rank: 1 });
    expect(second).toMatchObject({ employeeId: w.techA1Other.employeeId, rank: 2 });
    expect(first.score).toBeGreaterThan(second.score);
    expect(first.factors.map((factor: { key: string }) => factor.key)).toEqual(["DISTANCE", "WORKLOAD", "EXPERIENCE", "PREFERENCE"]);
    const distance = first.factors[0];
    expect(distance.value).toBeGreaterThan(0.5);
    expect(distance.value).toBeLessThan(1.5);
    expect(distance.explanationKey).toBe("DISPATCH.FACTOR.DISTANCE");
    expect(first.factors.reduce((sum: number, factor: { contribution: number }) => sum + factor.contribution, 0)).toBeCloseTo(first.score, 1);
    expect(second.factors[0].value).toBeGreaterThan(25);

    const afterwards = await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: job.id }, select: { status: true } }));
    expect(afterwards.status).toBe("PENDING_ASSIGNMENT");
    expect((await auditEvents(w.tenantId, "dispatch.recommend", rec.id))[0].actorUserId).toBe(w.dispatcher.userId);
  });

  it("stores ids and codes only (no names, no addresses) in the candidates JSON", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const stored = await withTenant(w.tenantId, (tx) => tx.dispatchRecommendation.findFirstOrThrow({ where: { id: rec.id } }));
    const text = JSON.stringify(stored.candidates);
    expect(text).not.toMatch(/12 Main St|Springfield|@/);
    const envelope = stored.candidates as { scoringVersion: number; ranked: Array<Record<string, unknown>> };
    expect(envelope.scoringVersion).toBe(1);
    expect(Object.keys(envelope.ranked[0]).sort()).toEqual(["conflicts", "employeeId", "factors", "rank", "score"]);
    expect(rec.scoringVersion).toBe(1);
  });

  it("never lists an employee who fails the hard rules, and says why on the candidates endpoint", async () => {
    const job = await createJobViaApi(w); // "repair": needs the EPA license, which techA1Other lacks
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect(rec.candidates.map((candidate: { employeeId: string }) => candidate.employeeId)).toEqual([w.techA1.employeeId]);

    const overview = (await candidates(w.cookie.dispatcher, job.id)).json.data;
    expect(overview.eligibleEmployeeIds).toEqual([w.techA1.employeeId]);
    const blocked = overview.blocked.find((entry: { employeeId: string }) => entry.employeeId === w.techA1Other.employeeId);
    expect(blocked.failures.map((failure: { code: string }) => failure.code)).toContain("QUALIFICATION_MISSING");
    expect(overview.distanceBasis).toBe("STRAIGHT_LINE_ESTIMATE");
  });

  it("keeps the job pending and records blocking reasons per employee when nobody is eligible", async () => {
    // City B is outside every technician's territory.
    const job = await createJobViaApi(w, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId }, w.cookie.ceo);
    const response = await generate(w.cookie.ceo, job.id);
    expect(response.status).toBe(201);
    const rec = response.json.data;
    expect(rec.candidates).toEqual([]);
    expect(rec.status).toBe("PENDING");
    const reasons = rec.blockingReasons[w.techA1.employeeId as string].map((failure: { code: string }) => failure.code);
    expect(reasons).toContain("OUTSIDE_TERRITORY");
    // techB has neither a territory nor a job permission: not a candidate at all, so not listed.
    expect(Object.keys(rec.blockingReasons)).not.toContain(w.techB.employeeId);
    expect(rec.poolTruncated).toBe(false);

    const stored = await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: job.id }, select: { status: true } }));
    expect(stored.status).toBe("PENDING_ASSIGNMENT");
  });

  it("a new recommendation supersedes the pending one", async () => {
    const job = await inspectionJob();
    const first = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const second = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await read(w.cookie.dispatcher, first.id)).json.data.status).toBe("SUPERSEDED");
    expect((await read(w.cookie.dispatcher, second.id)).json.data.status).toBe("PENDING");
    const list = await listFor(w.cookie.dispatcher, job.id);
    expect(list.json.data.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
  });
});

describe("soft factors", () => {
  it("flags and penalises an employee the customer wants to avoid, and lifts a preferred one", async () => {
    const fresh = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const addressId = await makeAddress(w.tenantId, fresh.id, { orgUnitId: w.units.cityA, isPrimary: true });
    await withTenant(w.tenantId, async (tx) => {
      await tx.customerAddress.update({ where: { id: addressId }, data: { latitude: 40.0, longitude: -89.0, coordinateSource: "manual" } });
      await tx.customerPreferredEmployee.create({ data: { tenantId: w.tenantId, customerId: fresh.id, employeeId: w.techA1.employeeId as string, kind: "AVOID" } });
    });
    const job = await createJobViaApi(w, { ...w.inspectionBody, customerId: fresh.id, serviceAddressId: addressId });
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    // techA1 is 1 km away but avoided (-30); techA1Other is 28 km away: the avoided employee ranks second.
    expect(rec.candidates.map((candidate: { employeeId: string }) => candidate.employeeId)).toEqual([w.techA1Other.employeeId, w.techA1.employeeId]);
    const avoided = rec.candidates[1];
    expect(avoided.conflicts.map((conflict: { code: string }) => conflict.code)).toContain("CUSTOMER_AVOIDS_EMPLOYEE");
    expect(avoided.factors[3]).toMatchObject({ key: "PREFERENCE", value: "AVOID", contribution: -30, explanationKey: "DISPATCH.FACTOR.PREFERENCE_AVOID" });
  });

  it("counts completed jobs of the same type as experience, and only that: no performance data", async () => {
    const done = await inspectionJob();
    await withTenant(w.tenantId, async (tx) => {
      await tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: done.id, employeeId: w.techA1Other.employeeId as string, state: "ENDED", endedAt: new Date(Date.now() + 60_000), endedReason: "Closed" } });
      await tx.job.update({ where: { id: done.id }, data: { status: "CLOSED" } });
    });
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const other = rec.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === w.techA1Other.employeeId);
    const own = rec.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === w.techA1.employeeId);
    expect(other.factors[2]).toMatchObject({ key: "EXPERIENCE", value: 1, contribution: 2 });
    expect(own.factors[2]).toMatchObject({ value: 0, contribution: 0 });
    expect(JSON.stringify(rec)).not.toMatch(/rating|speed|revenue|performance/i);
  });

  it("does not count a completed job for someone it was reassigned away from", async () => {
    const done = await inspectionJob();
    const t0 = Date.now() - 10 * 60_000;
    await withTenant(w.tenantId, async (tx) => {
      await tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: done.id, employeeId: w.techA1.employeeId as string, assignedAt: new Date(t0), state: "ENDED", endedAt: new Date(t0 + 60_000), endedReason: "Reassigned" } });
      await tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: done.id, employeeId: w.techA1Other.employeeId as string, assignedAt: new Date(t0 + 60_000), state: "ENDED", endedAt: new Date(t0 + 120_000), endedReason: "Closed" } });
      await tx.job.update({ where: { id: done.id }, data: { status: "CLOSED" } });
    });
    const rec = (await generate(w.cookie.dispatcher, (await inspectionJob()).id)).json.data;
    const experienceOf = (employeeId: string | null) => rec.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === employeeId).factors[2].value;
    expect(experienceOf(w.techA1.employeeId)).toBe(0);
    expect(experienceOf(w.techA1Other.employeeId)).toBeGreaterThanOrEqual(1);
  });

  it("counts open assigned jobs as workload", async () => {
    const busy = await inspectionJob();
    await withTenant(w.tenantId, async (tx) => {
      await tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: busy.id, employeeId: w.techA1.employeeId as string } });
      await tx.job.update({ where: { id: busy.id }, data: { status: "ASSIGNED" } });
    });
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const own = rec.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === w.techA1.employeeId);
    expect(own.factors[1]).toMatchObject({ key: "WORKLOAD", value: 1, contribution: 24 });
  });

  it("scores an employee without any coordinates as neutral and flags the missing distance", async () => {
    const lone = await inspectionJob();
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: w.techA1Other.employeeId as string }, data: { startLatitude: null, startLongitude: null } }));
    const rec = (await generate(w.cookie.dispatcher, lone.id)).json.data;
    const other = rec.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === w.techA1Other.employeeId);
    expect(other.factors[0]).toMatchObject({ value: null, contribution: 20, explanationKey: "DISPATCH.FACTOR.DISTANCE_UNKNOWN" });
    expect(other.conflicts.map((conflict: { code: string }) => conflict.code)).toContain("DISTANCE_UNKNOWN");
  });
});
