import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  assignCase,
  assignCaseSchema,
  changeCaseStatus,
  changeCaseStatusSchema,
  getCase,
  listCases,
  listCasesQuerySchema,
  recordAttempt,
  recordAttemptSchema,
  recoverCase,
  recoverCaseSchema,
  recoverySummary,
  refreshPresence,
  summaryQuerySchema,
  updateCase,
  updateCaseSchema,
} from "@/server/recovery";
import { disconnect } from "../authz/fixtures";
import { makeJob, makeLead } from "../customers/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildRecoveryWorld, makeActiveRule, makeOutcome, makeSiteJob, storeLocation, SITE, type RecoveryWorld } from "./fixtures";

let w: RecoveryWorld;

beforeAll(async () => {
  w = await buildRecoveryWorld("recovery-cases");
  await makeActiveRule(w, { actions: [{ type: "create_case" }, { type: "recommend", code: "call_customer" }] });
});
afterAll(disconnect);

type P = RecoveryWorld["ceo"];
const ctx = (person: P) => contextFor(person.actor);
const assign = (person: P, caseId: string, assigneeId: string | null) => assignCase(person.actor, ctx(person), caseId, assignCaseSchema.parse({ assigneeId }));
const status = (person: P, caseId: string, to: string, reason?: string) => changeCaseStatus(person.actor, ctx(person), caseId, changeCaseStatusSchema.parse({ status: to, reason }));
const attempt = (person: P, caseId: string, fields: Record<string, unknown> = {}) => recordAttempt(person.actor, ctx(person), caseId, recordAttemptSchema.parse({ channel: "PHONE", ...fields }));

/** A fresh NEW case for a fresh job of the world's customer. */
async function newCase(quoted = 150_000): Promise<{ caseId: string; jobId: string }> {
  const jobId = await makeSiteJob(w);
  const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: quoted });
  const row = await withTenant(w.tenantId, (tx) => tx.leadRecoveryCase.findFirstOrThrow({ where: { tenantId: w.tenantId, jobOutcomeId: outcomeId } }));
  return { caseId: row.id, jobId };
}

describe("reading cases", () => {
  it("shows a case with presence as a status only: no coordinates, no location event id, no distance", async () => {
    await storeLocation(w, w.techA1.employeeId as string, { latitude: SITE.latitude, longitude: SITE.longitude, accuracyM: 12 });
    const { caseId } = await newCase();
    const view = await getCase(w.leadOps.actor, caseId);
    expect(view).toMatchObject({ status: "NEW", presenceStatus: "AT_LOCATION", presenceAccuracyM: 12, nextStatuses: ["ASSIGNED", "CONTACTING", "CLOSED"] });
    expect(typeof view.presenceAgeMinutes).toBe("number");
    for (const hidden of ["presenceLocationEventId", "presenceDistanceM", "latitude", "longitude"]) expect(view).not.toHaveProperty(hidden);
    expect(JSON.stringify(view)).not.toContain(String(SITE.latitude));
  });

  it("keeps confirmed and estimated revenue apart", async () => {
    const { caseId } = await newCase(90_000);
    const view = await getCase(w.leadOps.actor, caseId);
    expect(view.revenue).toEqual({ currency: "USD", confirmed: null, estimated: { estimatedValueMinor: 90_000, initialValueMinor: 90_000 } });
    expect(view.recoveredAmountMinor).toBeNull();
  });

  it("is scoped: another unit's Lead Ops sees 404 and an empty list; a technician has no access", async () => {
    const { caseId } = await newCase();
    await expect(getCase(w.leadOpsB.actor, caseId)).rejects.toBeInstanceOf(NotFoundError);
    const theirs = await listCases(w.leadOpsB.actor, listCasesQuerySchema.parse({ limit: 100 }));
    expect(theirs.data.map((row) => row.id)).not.toContain(caseId);
    const mine = await listCases(w.leadOps.actor, listCasesQuerySchema.parse({ limit: 100 }));
    expect(mine.data.map((row) => row.id)).toContain(caseId);
    await expect(getCase(w.techA1.actor, caseId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listCases(w.ceo.actor, listCasesQuerySchema.parse({ limit: 100 }))).data.map((row) => row.id)).toContain(caseId);
  });

  it("filters the queue by status, open, priority, assignee and presence", async () => {
    const { caseId } = await newCase();
    await assign(w.leadOps, caseId, w.cityManagerA.employeeId as string);
    const assigned = await listCases(w.leadOps.actor, listCasesQuerySchema.parse({ status: "ASSIGNED", assignedToId: w.cityManagerA.employeeId, limit: 100 }));
    expect(assigned.data.map((row) => row.id)).toEqual([caseId]);
    const unassigned = await listCases(w.leadOps.actor, listCasesQuerySchema.parse({ assignedToId: "none", open: "true", limit: 100 }));
    expect(unassigned.data.every((row) => row.assignedToId === null)).toBe(true);
    expect(unassigned.data.map((row) => row.id)).not.toContain(caseId);
  });
});

describe("assignment", () => {
  it("assigns a NEW case (NEW -> ASSIGNED with history), notifies the new owner and audits", async () => {
    const { caseId } = await newCase();
    const view = await assign(w.leadOps, caseId, w.cityManagerA.employeeId as string);
    expect(view).toMatchObject({ status: "ASSIGNED", assignedToId: w.cityManagerA.employeeId });
    const history = await withTenant(w.tenantId, (tx) => tx.recoveryCaseStatusHistory.findMany({ where: { tenantId: w.tenantId, caseId }, orderBy: { occurredAt: "asc" } }));
    expect(history.map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([[null, "NEW"], ["NEW", "ASSIGNED"]]);
    expect(await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { recipientId: w.cityManagerA.userId, eventType: "recovery.case_assigned" } }))).toBeGreaterThan(0);
    expect((await auditEvents(w.tenantId, "recovery.case_assign", caseId))[0].actorUserId).toBe(w.leadOps.userId);
  });

  it("unassigning an ASSIGNED case returns it to NEW", async () => {
    const { caseId } = await newCase();
    await assign(w.leadOps, caseId, w.cityManagerA.employeeId as string);
    expect(await assign(w.leadOps, caseId, null)).toMatchObject({ status: "NEW", assignedToId: null });
  });

  it("refuses an assignee who cannot see the case (another unit's manager, a technician without recovery), a missing one, and a closed case", async () => {
    const { caseId } = await newCase();
    await expect(assign(w.leadOps, caseId, w.cityManagerB.employeeId as string)).rejects.toBeInstanceOf(ValidationError);
    await expect(assign(w.leadOps, caseId, w.techA1.employeeId as string)).rejects.toBeInstanceOf(ValidationError);
    await expect(assign(w.leadOps, caseId, "nobody")).rejects.toBeInstanceOf(ValidationError);
    await status(w.leadOps, caseId, "CLOSED", "Customer moved away");
    await expect(assign(w.leadOps, caseId, w.cityManagerA.employeeId as string)).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("needs recovery.assign over the case's unit", async () => {
    const { caseId } = await newCase();
    await expect(assign(w.leadOpsB, caseId, w.cityManagerA.employeeId as string)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assign(w.dispatcher, caseId, w.cityManagerA.employeeId as string)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("status machine and attempts (§9.5)", () => {
  it("walks NEW -> CONTACTING (first attempt) -> CUSTOMER_REACHED -> FOLLOW_UP_REQUIRED, counts attempts and keeps the history", async () => {
    const { caseId } = await newCase();
    const logged = await attempt(w.leadOps, caseId, { outcome: "NO_ANSWER", notes: "Secret note", durationSeconds: 30 });
    expect(logged).toMatchObject({ channel: "PHONE", outcome: "NO_ANSWER", employeeId: w.leadOps.employeeId, notes: "Secret note" });
    let view = await getCase(w.leadOps.actor, caseId);
    expect(view).toMatchObject({ status: "CONTACTING", attemptCount: 1 });
    expect(view.lastAttemptAt).not.toBeNull();
    await attempt(w.leadOps, caseId, { outcome: "REACHED", offeredAmountMinor: 99_000 });
    await status(w.leadOps, caseId, "CUSTOMER_REACHED");
    await status(w.leadOps, caseId, "FOLLOW_UP_REQUIRED");
    view = await getCase(w.leadOps.actor, caseId);
    expect(view).toMatchObject({ status: "FOLLOW_UP_REQUIRED", attemptCount: 2 });
    expect((view.attempts as unknown[]).length).toBe(2);
    expect((view.statusHistory as Array<{ toStatus: string }>).map((entry) => entry.toStatus).reverse()).toEqual(["NEW", "CONTACTING", "CUSTOMER_REACHED", "FOLLOW_UP_REQUIRED"]);
    const audit = (await auditEvents(w.tenantId, "recovery.attempt_record", caseId))[0];
    expect(JSON.stringify(audit.newValue)).not.toContain("Secret note");
  });

  it("refuses shortcuts, a future attempt time, closing without a reason, and attempts on a closed case", async () => {
    const { caseId } = await newCase();
    await expect(status(w.leadOps, caseId, "CUSTOMER_REACHED")).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(status(w.leadOps, caseId, "CLOSED")).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt(w.leadOps, caseId, { occurredAt: new Date(Date.now() + 3_600_000) })).rejects.toBeInstanceOf(ValidationError);
    await status(w.leadOps, caseId, "CLOSED", "Not interested");
    await expect(attempt(w.leadOps, caseId)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(await getCase(w.leadOps.actor, caseId)).toMatchObject({ status: "CLOSED", closeReason: "Not interested" });
  });

  it("NOT_RECOVERED records the final outcome with a reason and can be reopened to CONTACTING", async () => {
    const { caseId } = await newCase();
    await status(w.leadOps, caseId, "CONTACTING");
    const lost = await status(w.leadOps, caseId, "NOT_RECOVERED", "Went with a competitor");
    expect(lost).toMatchObject({ status: "NOT_RECOVERED", closeReason: "Went with a competitor" });
    expect(lost.closedAt).not.toBeNull();
    const reopened = await status(w.leadOps, caseId, "CONTACTING", "Customer called back");
    expect(reopened).toMatchObject({ status: "CONTACTING", closedAt: null, closeReason: null });
  });

  it("editing the estimate never touches confirmed revenue", async () => {
    const { caseId } = await newCase();
    const view = await updateCase(w.leadOps.actor, ctx(w.leadOps), caseId, updateCaseSchema.parse({ estimatedValueMinor: 250_000, priority: "HIGH" }));
    expect(view).toMatchObject({ estimatedValueMinor: 250_000, priority: "HIGH", recoveredAmountMinor: null, recoveredAt: null });
    expect(view.revenue).toMatchObject({ confirmed: null });
  });

  it("editing needs recovery.edit over the case; viewers cannot", async () => {
    const { caseId } = await newCase();
    await expect(status(w.leadOpsB, caseId, "CONTACTING")).rejects.toBeInstanceOf(NotFoundError);
    await expect(attempt(w.dispatcher, caseId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("recovery and attribution (§9.7)", () => {
  it("confirms the recovery: confirmed amounts with recoveredAt, recovered job and lead linked to the same customer, estimate untouched", async () => {
    const { caseId, jobId } = await newCase(100_000);
    await status(w.leadOps, caseId, "CONTACTING");
    const newJob = await makeJob(w.tenantId, w.customerId, w.units.cityA);
    const newLead = await makeLead(w.tenantId, w.customerId, { orgUnitId: w.units.cityA });
    const view = await recoverCase(w.leadOps.actor, ctx(w.leadOps), caseId, recoverCaseSchema.parse({ recoveredAmountMinor: 80_000, collectedAmountMinor: 30_000, recoveredJobId: newJob, recoveredLeadId: newLead }));
    expect(view).toMatchObject({
      status: "RECOVERED",
      jobId,
      customerId: w.customerId,
      recoveredJobId: newJob,
      recoveredLeadId: newLead,
      recoveredAmountMinor: 80_000,
      collectedAmountMinor: 30_000,
      estimatedValueMinor: 100_000,
      recoveredById: w.leadOps.userId,
    });
    expect(view.revenue).toMatchObject({ confirmed: { recoveredAmountMinor: 80_000, collectedAmountMinor: 30_000 }, estimated: { estimatedValueMinor: 100_000 } });
    expect(view.recoveredAt).not.toBeNull();
    expect(view.nextStatuses).toEqual(["CLOSED"]);
    await expect(recoverCase(w.leadOps.actor, ctx(w.leadOps), caseId, recoverCaseSchema.parse({ recoveredAmountMinor: 1 }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("refuses recovering from NEW, the case's own job, another customer's job, collected > recovered, and a future time", async () => {
    const { caseId, jobId } = await newCase();
    await expect(recoverCase(w.leadOps.actor, ctx(w.leadOps), caseId, recoverCaseSchema.parse({ recoveredAmountMinor: 1 }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await status(w.leadOps, caseId, "CONTACTING");
    const run = (fields: Record<string, unknown>) => recoverCase(w.leadOps.actor, ctx(w.leadOps), caseId, recoverCaseSchema.parse({ recoveredAmountMinor: 10_000, ...fields }));
    await expect(run({ recoveredJobId: jobId })).rejects.toBeInstanceOf(ValidationError);
    const stranger = await withTenant(w.tenantId, async (tx) => (await tx.customer.create({ data: { tenantId: w.tenantId, number: 70_000 + Math.floor(Math.random() * 9_000), name: "Stranger" } })).id);
    const strangerJob = await makeJob(w.tenantId, stranger, w.units.cityA);
    await expect(run({ recoveredJobId: strangerJob })).rejects.toBeInstanceOf(ValidationError);
    await expect(run({ collectedAmountMinor: 20_000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(run({ recoveredAt: new Date(Date.now() + 86_400_000) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("the database refuses confirmed revenue without a time or on the case's own job", async () => {
    const { caseId, jobId } = await newCase();
    await expect(withTenant(w.tenantId, (tx) => tx.leadRecoveryCase.update({ where: { id: caseId }, data: { recoveredAmountMinor: 5 } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.leadRecoveryCase.update({ where: { id: caseId }, data: { recoveredAt: new Date(), recoveredJobId: jobId } }))).rejects.toThrow();
  });

  it("summarises confirmed and estimated revenue separately per currency", async () => {
    const world = await buildRecoveryWorld("recovery-summary");
    await makeActiveRule(world, {});
    const jobA = await makeSiteJob(world);
    const a = await makeOutcome(world, jobA, { quotedAmountMinor: 40_000 });
    const jobB = await makeSiteJob(world);
    await makeOutcome(world, jobB, { quotedAmountMinor: 60_000 });
    const rows = await withTenant(world.tenantId, (tx) => tx.leadRecoveryCase.findMany({ where: { tenantId: world.tenantId }, orderBy: { number: "asc" } }));
    const caseA = rows.find((row) => row.jobOutcomeId === a.outcomeId)!;
    const c = (person: P) => contextFor(person.actor);
    await changeCaseStatus(world.leadOps.actor, c(world.leadOps), caseA.id, changeCaseStatusSchema.parse({ status: "CONTACTING" }));
    await recoverCase(world.leadOps.actor, c(world.leadOps), caseA.id, recoverCaseSchema.parse({ recoveredAmountMinor: 35_000, collectedAmountMinor: 35_000 }));
    const summary = await recoverySummary(world.leadOps.actor, summaryQuerySchema.parse({}));
    expect(summary).toMatchObject({
      casesByStatus: { RECOVERED: 1, NEW: 1 },
      confirmed: [{ currency: "USD", cases: 1, recoveredAmountMinor: 35_000, collectedAmountMinor: 35_000 }],
      estimated: [{ currency: "USD", openCases: 1, estimatedValueMinor: 60_000 }],
    });
  });
});

describe("presence refresh", () => {
  it("re-evaluates from the latest valid event and stores only the status snapshot", async () => {
    const { caseId } = await newCase();
    const before = await getCase(w.leadOps.actor, caseId);
    await storeLocation(w, w.techA1.employeeId as string, { latitude: SITE.latitude + 0.2, longitude: SITE.longitude, accuracyM: 8 });
    const view = await refreshPresence(w.leadOps.actor, ctx(w.leadOps), caseId);
    expect(view).toMatchObject({ presenceStatus: "LEFT_LOCATION", presenceAccuracyM: 8 });
    expect(before.presenceEvaluatedAt).not.toEqual(view.presenceEvaluatedAt);
    expect(JSON.stringify(view)).not.toContain(String(SITE.latitude + 0.2));
  });
});
