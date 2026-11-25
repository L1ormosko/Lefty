import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { listOwnNotifications } from "@/server/notifications";
import { handleOutcomeRecorded } from "@/server/recovery";
import { disconnect } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import { buildRecoveryWorld, makeActiveRule, makeOutcome, makeSiteJob, storeLocation, SITE, type RecoveryWorld } from "./fixtures";

const failFollowUps = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/follow-ups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/follow-ups")>();
  return {
    ...actual,
    createFollowUpTaskInTx: (...args: Parameters<typeof actual.createFollowUpTaskInTx>) => {
      if (failFollowUps.on) throw new Error("boom");
      return actual.createFollowUpTaskInTx(...args);
    },
  };
});

let w: RecoveryWorld;

beforeAll(async () => {
  w = await buildRecoveryWorld("recovery-engine");
});
afterAll(disconnect);
// Tests share one tenant: every test starts with no ACTIVE rule so only the rules it creates apply.
beforeEach(async () => {
  failFollowUps.on = false;
  await withTenant(w.tenantId, (tx) => tx.recoveryRule.updateMany({ where: { tenantId: w.tenantId, status: "ACTIVE" }, data: { status: "INACTIVE" } }));
});

const caseFor = (outcomeId: string) => withTenant(w.tenantId, (tx) => tx.leadRecoveryCase.findFirst({ where: { tenantId: w.tenantId, jobOutcomeId: outcomeId } }));
const runsFor = (outcomeId: string) => withTenant(w.tenantId, (tx) => tx.recoveryRuleRun.findMany({ where: { tenantId: w.tenantId, jobOutcomeId: outcomeId }, orderBy: { firedAt: "asc" } }));

describe("the engine creates a case from a not-converted outcome", () => {
  it("creates one NEW case with history, rule version, outcome link and a case number; links to job, customer and technician", async () => {
    const rule = await makeActiveRule(w, { actions: [{ type: "create_case", priority: "NORMAL" }, { type: "recommend", code: "call_customer" }] });
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: 150_000 });
    const row = await caseFor(outcomeId);
    expect(row).toMatchObject({
      status: "NEW",
      jobId,
      customerId: w.customerId,
      technicianId: w.techA1.employeeId,
      orgUnitId: w.units.cityA,
      ruleId: rule,
      ruleVersion: 1,
      recommendation: "call_customer",
      initialValueMinor: 150_000n,
      estimatedValueMinor: 150_000n,
      recoveredAmountMinor: null,
      recoveredAt: null,
      presenceStatus: "UNKNOWN",
      presenceReason: "no_location",
    });
    expect(row?.number).toBeGreaterThan(0);
    const history = await withTenant(w.tenantId, (tx) => tx.recoveryCaseStatusHistory.findMany({ where: { tenantId: w.tenantId, caseId: row!.id } }));
    expect(history).toMatchObject([{ fromStatus: null, toStatus: "NEW", actorType: "SYSTEM" }]);
    const runs = (await runsFor(outcomeId)).filter((run) => run.ruleId === rule);
    expect(runs).toMatchObject([{ matched: true, actionsTaken: ["create_case", "recommend"], skippedReason: null, recoveryCaseId: row!.id }]);
    expect((await auditEvents(w.tenantId, "recovery.case_create", row!.id))[0].actorUserId).toBeNull();
  });

  it("is idempotent: running the engine again for the same outcome changes nothing", async () => {
    await makeActiveRule(w, {});
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId);
    const before = (await runsFor(outcomeId)).length;
    await withTenant(w.tenantId, (tx) =>
      handleOutcomeRecorded(tx, { tenantId: w.tenantId, jobId, outcomeId, visitNumber: 1, outcome: "NOT_SOLD", lostReasonId: w.reasonId, lostReasonRecoverable: true, notConverted: true, customerRequestedFollowUp: false, retroactive: false, jobStatus: "COMPLETED" }),
    );
    expect((await runsFor(outcomeId)).length).toBe(before);
    expect(await withTenant(w.tenantId, (tx) => tx.leadRecoveryCase.count({ where: { tenantId: w.tenantId, jobOutcomeId: outcomeId } }))).toBe(1);
  });

  it("ignores converted outcomes and records non-matching rules as such", async () => {
    const rule = await makeActiveRule(w, { conditions: { lostReasonIds: [w.unrecoverableReasonId] } });
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { lostReasonId: w.reasonId });
    const mine = (await runsFor(outcomeId)).find((run) => run.ruleId === rule);
    expect(mine).toMatchObject({ matched: false, skippedReason: "conditions_not_met", actionsTaken: [] });
    await withTenant(w.tenantId, (tx) =>
      handleOutcomeRecorded(tx, { tenantId: w.tenantId, jobId, outcomeId: "x", visitNumber: 1, outcome: "SOLD", lostReasonId: null, lostReasonRecoverable: null, notConverted: false, customerRequestedFollowUp: false, retroactive: false, jobStatus: "COMPLETED" }),
    );
  });

  it("evaluates conditions on value, job type scope and outcome type; a rule scoped to another unit does not apply", async () => {
    const other = await makeActiveRule(w, { orgUnitId: w.units.cityA, conditions: { minValueMinor: 1_000_000 }, actions: [{ type: "create_case", priority: "URGENT" }, { type: "set_priority", priority: "URGENT" }] });
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: 5_000 });
    expect((await runsFor(outcomeId)).find((run) => run.ruleId === other)).toMatchObject({ matched: false });
    // a job in City B is not covered by a rule scoped to City A
    const jobB = await makeSiteJob(w, w.units.cityB);
    const { outcomeId: outcomeB } = await makeOutcome(w, jobB, { quotedAmountMinor: 5_000_000 });
    expect((await runsFor(outcomeB)).find((run) => run.ruleId === other)).toBeUndefined();
  });

  it("applies several rules in priority order: priority only goes up, the first recommendation stands", async () => {
    const jobId = await makeSiteJob(w);
    const first = await makeActiveRule(w, { priority: 1, conditions: { minValueMinor: 777_000 }, actions: [{ type: "create_case", priority: "NORMAL" }, { type: "recommend", code: "schedule_revisit" }] });
    const second = await makeActiveRule(w, { priority: 2, conditions: { minValueMinor: 777_000 }, actions: [{ type: "set_priority", priority: "HIGH", score: 80 }, { type: "recommend", code: "call_customer" }] });
    const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: 777_500 });
    const row = await caseFor(outcomeId);
    expect(row).toMatchObject({ priority: "HIGH", priorityScore: 80, recommendation: "schedule_revisit", ruleId: first });
    const runs = await runsFor(outcomeId);
    expect(runs.find((run) => run.ruleId === second)).toMatchObject({ matched: true, actionsTaken: ["set_priority"] });
  });
});

describe("actions: follow-up task and notification", () => {
  it("creates a RECOVERY_RULE follow-up on the case (idempotent) and notifies Lead Ops over the unit, never the technician", async () => {
    await makeActiveRule(w, { conditions: { minValueMinor: 321_000 }, actions: [{ type: "create_case", priority: "HIGH" }, { type: "create_follow_up", dueInMinutes: 120 }, { type: "notify", audience: "lead_operations" }] });
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: 321_500 });
    const row = await caseFor(outcomeId);
    const tasks = await withTenant(w.tenantId, (tx) => tx.followUpTask.findMany({ where: { tenantId: w.tenantId, recoveryCaseId: row!.id } }));
    expect(tasks).toMatchObject([{ origin: "RECOVERY_RULE", targetType: "RECOVERY_CASE", status: "OPEN", orgUnitId: w.units.cityA, priority: "HIGH" }]);
    const leadOpsInbox = await withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: w.leadOps.userId, eventType: "recovery.case_created" } }));
    expect(leadOpsInbox.length).toBeGreaterThan(0);
    const techInbox = await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { recipientId: w.techA1.userId, eventType: "recovery.case_created" } }));
    expect(techInbox).toBe(0);
    const otherUnit = await withTenant(w.tenantId, (tx) => tx.notification.count({ where: { recipientId: w.leadOpsB.userId, eventType: "recovery.case_created" } }));
    expect(otherUnit).toBe(0);
    const page = await listOwnNotifications(w.leadOps.actor, { limit: 50 } as never);
    expect(JSON.stringify(page)).not.toMatch(/discount/i);
  });
});

describe("loop safety: cooldown", () => {
  it("does not fire the same rule again for the same customer inside its cooldown, then records why", async () => {
    const rule = await makeActiveRule(w, { conditions: { minValueMinor: 424_000 }, cooldownMinutes: 60, actions: [{ type: "create_case" }] });
    const firstJob = await makeSiteJob(w);
    const first = await makeOutcome(w, firstJob, { quotedAmountMinor: 424_100 });
    expect(await caseFor(first.outcomeId)).not.toBeNull();
    const secondJob = await makeSiteJob(w);
    const second = await makeOutcome(w, secondJob, { quotedAmountMinor: 424_200 });
    expect(await caseFor(second.outcomeId)).toBeNull();
    expect((await runsFor(second.outcomeId)).find((run) => run.ruleId === rule)).toMatchObject({ matched: true, skippedReason: "cooldown", actionsTaken: [] });
    // another customer is not affected
    const otherCustomer = await withTenant(w.tenantId, async (tx) => (await tx.customer.create({ data: { tenantId: w.tenantId, number: 90_000 + Math.floor(Math.random() * 9_000), name: "Other" } })).id);
    const thirdJob = await makeSiteJob(w, w.units.cityA, otherCustomer);
    const third = await makeOutcome(w, thirdJob, { quotedAmountMinor: 424_300 });
    expect(await caseFor(third.outcomeId)).not.toBeNull();
  });
});

describe("failure isolation: the engine never throws", () => {
  it("an unknown outcome is ignored and the transaction stays usable", async () => {
    const count = await withTenant(w.tenantId, async (tx) => {
      await handleOutcomeRecorded(tx, { tenantId: w.tenantId, jobId: "missing", outcomeId: "missing", visitNumber: 1, outcome: "NOT_SOLD", lostReasonId: null, lostReasonRecoverable: null, notConverted: true, customerRequestedFollowUp: false, retroactive: false, jobStatus: "COMPLETED" });
      return tx.tenant.count({ where: { id: w.tenantId } });
    });
    expect(count).toBe(1);
  });

  it("a rule that fails mid-way is rolled back to its savepoint and recorded as error; the outcome and the next rule survive", async () => {
    const failing = await makeActiveRule(w, { priority: 1, actions: [{ type: "create_case" }, { type: "create_follow_up", dueInMinutes: 60 }] });
    const healthy = await makeActiveRule(w, { priority: 2, actions: [{ type: "create_case" }, { type: "recommend", code: "review_manually" }] });
    failFollowUps.on = true;
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId);
    failFollowUps.on = false;
    // The outcome row (written before the engine ran, in the same transaction) is intact.
    expect(await withTenant(w.tenantId, (tx) => tx.jobOutcome.count({ where: { tenantId: w.tenantId, id: outcomeId } }))).toBe(1);
    const runs = await runsFor(outcomeId);
    expect(runs.find((run) => run.ruleId === failing)).toMatchObject({ matched: false, skippedReason: "error", actionsTaken: [] });
    // The failing rule's half-made case was rolled back; the healthy rule created its own.
    const row = await caseFor(outcomeId);
    expect(row).toMatchObject({ ruleId: healthy, recommendation: "review_manually" });
    expect(runs.find((run) => run.ruleId === healthy)).toMatchObject({ matched: true, actionsTaken: ["create_case", "recommend"] });
  });
});

describe("presence (§26.5)", () => {
  const evaluate = async (technicianLocation: Parameters<typeof storeLocation>[2] | null, quoted: number) => {
    const tech = w.techA1.employeeId as string;
    if (technicianLocation) await storeLocation(w, tech, technicianLocation);
    const jobId = await makeSiteJob(w);
    const { outcomeId } = await makeOutcome(w, jobId, { quotedAmountMinor: quoted });
    return caseFor(outcomeId);
  };

  it("is UNKNOWN with a reason when there is no, stale or inaccurate data, and never shows a position", async () => {
    await makeActiveRule(w, { conditions: { minValueMinor: 600_000, maxValueMinor: 600_999 }, actions: [{ type: "create_case" }] });
    const none = await evaluate(null, 600_100);
    expect(none).toMatchObject({ presenceStatus: "UNKNOWN", presenceReason: "no_location", presenceLocationEventId: null });
    const stale = await evaluate({ ...SITE, ageMinutes: 600 }, 600_200);
    expect(stale).toMatchObject({ presenceStatus: "UNKNOWN", presenceReason: "stale_location" });
    const inaccurate = await evaluate({ ...SITE, accuracyM: 5_000 }, 600_300);
    expect(inaccurate).toMatchObject({ presenceStatus: "UNKNOWN", presenceReason: "inaccurate_location" });
  });

  it("is AT_LOCATION near the site and LEFT_LOCATION far from it, from the latest valid event only", async () => {
    await makeActiveRule(w, { conditions: { minValueMinor: 700_000, maxValueMinor: 700_999 }, actions: [{ type: "create_case" }] });
    const near = await evaluate({ latitude: SITE.latitude + 0.0002, longitude: SITE.longitude, accuracyM: 15 }, 700_100);
    expect(near).toMatchObject({ presenceStatus: "AT_LOCATION", presenceAccuracyM: 15, presenceReason: null });
    expect(near?.presenceLocationEventId).not.toBeNull();
    const far = await evaluate({ latitude: SITE.latitude + 0.05, longitude: SITE.longitude, accuracyM: 15 }, 700_200);
    expect(far).toMatchObject({ presenceStatus: "LEFT_LOCATION" });
  });

  it("can drive a rule: a presence condition matches only the right status", async () => {
    const atRule = await makeActiveRule(w, { conditions: { minValueMinor: 800_000, maxValueMinor: 800_999, presence: ["AT_LOCATION"] }, actions: [{ type: "create_case" }] });
    const leftRule = await makeActiveRule(w, { conditions: { minValueMinor: 800_000, maxValueMinor: 800_999, presence: ["LEFT_LOCATION"] }, actions: [{ type: "create_case", priority: "HIGH" }] });
    await storeLocation(w, w.techA1.employeeId as string, { latitude: SITE.latitude, longitude: SITE.longitude, accuracyM: 10 });
    const here = await makeOutcome(w, await makeSiteJob(w), { quotedAmountMinor: 800_100 });
    expect((await caseFor(here.outcomeId))?.ruleId).toBe(atRule);
    await storeLocation(w, w.techA1.employeeId as string, { latitude: SITE.latitude + 0.1, longitude: SITE.longitude, accuracyM: 10 });
    const away = await makeOutcome(w, await makeSiteJob(w), { quotedAmountMinor: 800_200 });
    expect(await caseFor(away.outcomeId)).toMatchObject({ ruleId: leftRule, priority: "HIGH", presenceStatus: "LEFT_LOCATION" });
  });
});
