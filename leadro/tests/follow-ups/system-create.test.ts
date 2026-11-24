import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidStateTransitionError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { createFollowUp, createFollowUpSchema, createFollowUpTaskInTx, getFollowUp, listFollowUps, listFollowUpsQuerySchema } from "@/server/follow-ups";
import { createPerson, disconnect, grantTemplate } from "../authz/fixtures";
import { makeCustomer, makeJob, makeLead } from "../customers/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildFollowUpWorld, followUpRow, hoursFromNow, type FollowUpWorld } from "./fixtures";
import "@/server/recovery"; // registers the recovery-case follow-up target (the default fails closed)

let w: FollowUpWorld;
let leadOps: Awaited<ReturnType<typeof createPerson>>;
let recoveryCaseId: string;

const system = () => ({ tenantId: w.tenantId, system: true as const });

/** A recovery case row built directly (the recovery module that creates them belongs to another task). */
async function makeRecoveryCase(orgUnitId: string, assignedToId: string | null): Promise<string> {
  const customer = await makeCustomer(w.tenantId, { orgUnitId });
  const jobId = await makeJob(w.tenantId, customer.id, orgUnitId);
  return withTenant(w.tenantId, async (tx) => {
    const outcome = await tx.jobOutcome.create({ data: { tenantId: w.tenantId, jobId, outcome: "CUSTOMER_UNAVAILABLE" } });
    const row = await tx.leadRecoveryCase.create({
      data: {
        tenantId: w.tenantId,
        number: Math.floor(Math.random() * 1_000_000) + 1,
        jobOutcomeId: outcome.id,
        jobId,
        customerId: customer.id,
        orgUnitId,
        assignedToId,
        outcomeAt: new Date(),
        presenceStatus: "UNKNOWN",
        presenceReason: "no_location",
      },
    });
    return row.id;
  });
}

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-system");
  leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, leadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
  recoveryCaseId = await makeRecoveryCase(w.units.cityA, leadOps.employeeId);
});
afterAll(disconnect);

describe("createFollowUpTaskInTx for the recovery engine (system caller)", () => {
  it("creates a SYSTEM-origin task with no author, skipping permission checks but not data rules", async () => {
    const created = await withTenant(w.tenantId, (tx) =>
      createFollowUpTaskInTx(tx, system(), { targetType: "RECOVERY_CASE", targetId: recoveryCaseId, title: "Call the customer", dueAt: hoursFromNow(4), origin: "RECOVERY_RULE", priority: "HIGH", assigneeId: leadOps.employeeId }),
    );
    expect(created.created).toBe(true);
    expect(await followUpRow(w.tenantId, created.id)).toMatchObject({
      targetType: "RECOVERY_CASE",
      recoveryCaseId,
      origin: "RECOVERY_RULE",
      priority: "HIGH",
      createdById: null,
      orgUnitId: w.units.cityA,
      assigneeId: leadOps.employeeId,
    });
    const audit = (await auditEvents(w.tenantId, "follow_up.create", created.id))[0];
    expect(audit).toMatchObject({ actorType: "SYSTEM", actorUserId: null, sourceApp: "SYSTEM" });
    expect(created.notificationIds).toHaveLength(1); // the assignee is told
  });

  it("is idempotent per dedupeKey, also when two creators race", async () => {
    const input = { targetType: "RECOVERY_CASE" as const, targetId: recoveryCaseId, title: "Second try", dueAt: hoursFromNow(8), dedupeKey: `recovery:${recoveryCaseId}:rule-1` };
    const [one, two] = await Promise.all([
      withTenant(w.tenantId, (tx) => createFollowUpTaskInTx(tx, system(), input)),
      withTenant(w.tenantId, (tx) => createFollowUpTaskInTx(tx, system(), input)),
    ]);
    expect(one.id).toBe(two.id);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    const again = await withTenant(w.tenantId, (tx) => createFollowUpTaskInTx(tx, system(), input));
    expect(again).toMatchObject({ id: one.id, created: false, notificationIds: [] });
    const count = await withTenant(w.tenantId, (tx) => tx.followUpTask.count({ where: { tenantId: w.tenantId, dedupeKey: input.dedupeKey } }));
    expect(count).toBe(1);
  });

  it("rolls back with the caller's transaction", async () => {
    const dedupeKey = `rollback:${Date.now()}`;
    await expect(
      withTenant(w.tenantId, async (tx) => {
        await createFollowUpTaskInTx(tx, system(), { targetType: "JOB", targetId: w.jobA, title: "Gone", dueAt: hoursFromNow(1), dedupeKey });
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await withTenant(w.tenantId, (tx) => tx.followUpTask.count({ where: { tenantId: w.tenantId, dedupeKey } }))).toBe(0);
  });

  it("still refuses a missing or archived target and an assignee who could not work the task", async () => {
    const archived = await makeLead(w.tenantId, w.customerA, { orgUnitId: w.units.cityA, archived: true });
    const create = (input: { targetType: "LEAD" | "JOB"; targetId: string; assigneeId?: string }) =>
      withTenant(w.tenantId, (tx) => createFollowUpTaskInTx(tx, system(), { title: "x", dueAt: hoursFromNow(1), ...input }));
    await expect(create({ targetType: "LEAD", targetId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(create({ targetType: "LEAD", targetId: archived })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    // Lead Operations hold no jobs.view over a plain job: the task would land in a queue they cannot open.
    await expect(create({ targetType: "JOB", targetId: w.jobA, assigneeId: leadOps.employeeId as string })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("recovery-case targets (registered by the recovery module; unregistered they fail closed)", () => {
  it("lets Lead Operations follow up a case in their area and see the task", async () => {
    const view = await createFollowUp(leadOps.actor, contextFor(leadOps.actor), createFollowUpSchema.parse({ targetType: "RECOVERY_CASE", targetId: recoveryCaseId, title: "Offer a visit slot", dueAt: hoursFromNow(6) }));
    expect(view).toMatchObject({ targetType: "RECOVERY_CASE", recoveryCaseId });
    const page = await listFollowUps(leadOps.actor, listFollowUpsQuerySchema.parse({ targetType: "RECOVERY_CASE", targetId: recoveryCaseId }));
    expect(page.data.length).toBeGreaterThanOrEqual(2);
  });

  it("hides recovery follow-ups from people without recovery access, even with follow-up access over the area", async () => {
    const task = await withTenant(w.tenantId, (tx) => createFollowUpTaskInTx(tx, system(), { targetType: "RECOVERY_CASE", targetId: recoveryCaseId, title: "Hidden", dueAt: hoursFromNow(2) }));
    // The Dispatcher's follow_ups scope covers the state but dispatchers hold no recovery.view.
    await expect(getFollowUp(w.dispatcher.actor, task.id)).rejects.toBeInstanceOf(NotFoundError);
    const page = await listFollowUps(w.dispatcher.actor, listFollowUpsQuerySchema.parse({ limit: 200 }));
    expect(page.data.map((row) => row.id)).not.toContain(task.id);
    // A unit manager outside the case's area cannot reach it either; the Owner can.
    await expect(getFollowUp(w.cityManagerB.actor, task.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getFollowUp(w.ceo.actor, task.id)).toMatchObject({ id: task.id });
  });

  it("scopes a case to its assigned recovery employee when the scope is ASSIGNED-only", async () => {
    const custom = await createPerson(w.tenantId, "lead-ops-assigned", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    await grantTemplate(w.tenantId, custom, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ASSIGNED" }]);
    const mine = await makeRecoveryCase(w.units.cityA, custom.employeeId);
    const notMine = await makeRecoveryCase(w.units.cityA, leadOps.employeeId);
    const own = await createFollowUp(custom.actor, contextFor(custom.actor), createFollowUpSchema.parse({ targetType: "RECOVERY_CASE", targetId: mine, title: "Mine", dueAt: hoursFromNow(3), assigneeId: custom.employeeId }));
    expect(own.recoveryCaseId).toBe(mine);
    await expect(createFollowUp(custom.actor, contextFor(custom.actor), createFollowUpSchema.parse({ targetType: "RECOVERY_CASE", targetId: notMine, title: "Not mine", dueAt: hoursFromNow(3), assigneeId: custom.employeeId }))).rejects.toBeInstanceOf(NotFoundError);
  });
});
