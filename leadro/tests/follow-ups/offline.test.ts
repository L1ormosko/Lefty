import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, InvalidStateTransitionError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  cancelFollowUp,
  cancelFollowUpSchema,
  completeFollowUp,
  completeFollowUpSchema,
  createFollowUp,
  createFollowUpSchema,
} from "@/server/follow-ups";
import { disconnect } from "../authz/fixtures";
import { contextFor } from "../org/org-helpers";
import { buildFollowUpWorld, followUpRow, hoursFromNow, makeFollowUp, type FollowUpWorld } from "./fixtures";

let w: FollowUpWorld;
type Actor = FollowUpWorld["ceo"]["actor"];

const complete = (actor: Actor, id: string, fields: Record<string, unknown>) =>
  completeFollowUp(actor, contextFor(actor), id, completeFollowUpSchema.parse(fields));
const create = (actor: Actor, fields: Record<string, unknown>) =>
  createFollowUp(actor, contextFor(actor), createFollowUpSchema.parse({ title: "Offline task", dueAt: hoursFromNow(24), targetType: "JOB", targetId: w.jobA, ...fields }));
const fieldEvents = (clientEventId: string) =>
  withTenant(w.tenantId, (tx) => tx.fieldEvent.findMany({ where: { tenantId: w.tenantId, clientEventId } }));

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-offline");
});
afterAll(disconnect);

describe("offline writes (§8.7, §25.3)", () => {
  it("records the device time as completedAt and stores one ACCEPTED FieldEvent holding ids only", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    const clientEventId = randomUUID();
    const occurredAt = new Date(Date.now() - 3 * 3_600_000);
    const view = await complete(w.techA1.actor, id, { note: "Done from the van", clientEventId, occurredAt });
    expect(view.status).toBe("DONE");
    expect((await followUpRow(w.tenantId, id)).completedAt?.getTime()).toBe(occurredAt.getTime());

    const [event] = await fieldEvents(clientEventId);
    expect(event).toMatchObject({
      employeeId: w.techA1.employeeId,
      actorUserId: w.techA1.userId,
      type: "follow_up.complete",
      result: "ACCEPTED",
      resultCode: null,
      entityType: "FollowUpTask",
      entityId: id,
    });
    expect(event.occurredAt.getTime()).toBe(occurredAt.getTime());
    expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event.payload)).not.toContain("Done from the van"); // free text never enters the payload
    expect(event.payload).toEqual({ followUpId: id, status: "DONE" });
  });

  it("replays the same event without applying it twice, even after the task changed", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    const clientEventId = randomUUID();
    const first = await complete(w.techA1.actor, id, { clientEventId });
    const second = await complete(w.techA1.actor, id, { clientEventId });
    expect(second).toEqual(first);
    expect(await fieldEvents(clientEventId)).toHaveLength(1);
  });

  it("refuses the same clientEventId with different content (409) and changes nothing", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    const clientEventId = randomUUID();
    await complete(w.techA1.actor, id, { clientEventId, note: "first" });
    await expect(complete(w.techA1.actor, id, { clientEventId, note: "different" })).rejects.toBeInstanceOf(ConflictError);
    const other = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    await expect(complete(w.techA1.actor, other, { clientEventId, note: "first" })).rejects.toBeInstanceOf(ConflictError);
    expect((await followUpRow(w.tenantId, other)).status).toBe("OPEN");
  });

  it("stores a refused event as REJECTED and answers a replay with the same error, without re-evaluating", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    await cancelFollowUp(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), id, cancelFollowUpSchema.parse({ reason: "Not needed" }));
    const clientEventId = randomUUID();
    await expect(complete(w.cityManagerA.actor, id, { clientEventId })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const [stored] = await fieldEvents(clientEventId);
    expect(stored).toMatchObject({ result: "REJECTED", resultCode: "INVALID_STATE_TRANSITION", entityId: null });

    // The task is reopened meanwhile: re-evaluating would now succeed, a replay must still answer the original verdict.
    await withTenant(w.tenantId, (tx) =>
      tx.followUpTask.update({ where: { id }, data: { status: "OPEN", cancelledAt: null, cancelReason: null } }),
    );
    await expect(complete(w.cityManagerA.actor, id, { clientEventId })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect((await followUpRow(w.tenantId, id)).status).toBe("OPEN");
    expect(await fieldEvents(clientEventId)).toHaveLength(1);
  });

  it("does not store permission failures: the device may retry the same event once access is fixed", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const clientEventId = randomUUID();
    await expect(complete(w.cityManagerB.actor, id, { clientEventId })).rejects.toThrow();
    expect(await fieldEvents(clientEventId)).toHaveLength(0);
  });

  it("creates a task once per clientEventId", async () => {
    const clientEventId = randomUUID();
    const dueAt = hoursFromNow(24); // the device resends the same request body
    const first = await create(w.techA1.actor, { assigneeId: w.techA1.employeeId, clientEventId, dueAt });
    const second = await create(w.techA1.actor, { assigneeId: w.techA1.employeeId, clientEventId, dueAt });
    expect(second.id).toBe(first.id);
    const count = await withTenant(w.tenantId, (tx) => tx.followUpTask.count({ where: { tenantId: w.tenantId, title: "Offline task", createdById: w.techA1.userId } }));
    expect(count).toBe(1);
  });

  it("keeps event ids per employee: another employee's identical id is a different event", async () => {
    const clientEventId = randomUUID();
    const a = await create(w.techA1.actor, { assigneeId: w.techA1.employeeId, clientEventId });
    const b = await create(w.cityManagerA.actor, { clientEventId });
    expect(b.id).not.toBe(a.id);
    expect(await fieldEvents(clientEventId)).toHaveLength(2);
  });

  it("settles two concurrent submissions of one event to a single application", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    const clientEventId = randomUUID();
    const [one, two] = await Promise.all([complete(w.techA1.actor, id, { clientEventId }), complete(w.techA1.actor, id, { clientEventId })]);
    expect(one.id).toBe(two.id);
    expect(await fieldEvents(clientEventId)).toHaveLength(1);
  });

  it("refuses a future occurredAt and needs an employee record for offline events", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await expect(complete(w.cityManagerA.actor, id, { occurredAt: new Date(Date.now() + 3_600_000) })).rejects.toBeInstanceOf(ValidationError);
    // The Owner fixture has no employee record: such a user cannot own device events.
    await expect(complete(w.ceo.actor, id, { clientEventId: randomUUID() })).rejects.toMatchObject({ field: "clientEventId" });
    expect(() => completeFollowUpSchema.parse({ clientEventId: "not-a-uuid" })).toThrow();
  });
});
