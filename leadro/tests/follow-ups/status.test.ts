import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError } from "@/server/core";
import {
  cancelFollowUp,
  cancelFollowUpSchema,
  changeFollowUpStatus,
  changeFollowUpStatusSchema,
  completeFollowUp,
  completeFollowUpSchema,
  updateFollowUp,
  updateFollowUpSchema,
} from "@/server/follow-ups";
import { disconnect } from "../authz/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildFollowUpWorld, followUpRow, hoursFromNow, makeFollowUp, type FollowUpWorld } from "./fixtures";
import { withTenant } from "@/server/db";

let w: FollowUpWorld;
type Actor = FollowUpWorld["ceo"]["actor"];

const move = (actor: Actor, id: string, status: string) =>
  changeFollowUpStatus(actor, contextFor(actor), id, changeFollowUpStatusSchema.parse({ status }));
const complete = (actor: Actor, id: string, fields: Record<string, unknown> = {}) =>
  completeFollowUp(actor, contextFor(actor), id, completeFollowUpSchema.parse(fields));
const cancel = (actor: Actor, id: string, fields: Record<string, unknown> = { reason: "Customer moved away" }) =>
  cancelFollowUp(actor, contextFor(actor), id, cancelFollowUpSchema.parse(fields));
const edit = (actor: Actor, id: string, fields: Record<string, unknown>) =>
  updateFollowUp(actor, contextFor(actor), id, updateFollowUpSchema.parse(fields));

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-status");
});
afterAll(disconnect);

describe("the status machine", () => {
  it("starts, finishes and reopens a task, stamping who and when", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId });
    expect(await move(w.techA1.actor, id, "IN_PROGRESS")).toMatchObject({ status: "IN_PROGRESS" });
    const done = await complete(w.techA1.actor, id, { note: "Spoke to the customer" });
    expect(done).toMatchObject({ status: "DONE", completedById: w.techA1.userId, completionNote: "Spoke to the customer", nextStatuses: ["OPEN"] });
    expect(done.completedAt).toBeInstanceOf(Date);

    const reopened = await move(w.cityManagerA.actor, id, "OPEN");
    expect(reopened).toMatchObject({ status: "OPEN", completedAt: null, completedById: null, completionNote: null });
    expect(await auditEvents(w.tenantId, "follow_up.status_change", id)).toHaveLength(3);
  });

  it("keeps the completion note and cancel reason out of the audit trail", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await cancel(w.cityManagerA.actor, id, { reason: "Very private reason" });
    const audit = (await auditEvents(w.tenantId, "follow_up.status_change", id))[0];
    expect(JSON.stringify(audit.newValue)).not.toContain("Very private reason");
    expect(audit.newValue).toMatchObject({ status: "CANCELLED", hasReason: true });
  });

  it("cancels with a reason that is kept, and refuses moves the machine does not allow", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const cancelled = await cancel(w.cityManagerA.actor, id);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "Customer moved away", completedAt: null });
    await expect(complete(w.cityManagerA.actor, id)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(cancel(w.cityManagerA.actor, id)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(move(w.cityManagerA.actor, id, "IN_PROGRESS")).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(await move(w.cityManagerA.actor, id, "OPEN")).toMatchObject({ status: "OPEN", cancelledAt: null, cancelReason: null });
  });

  it("requires a cancel reason and refuses a no-op change", async () => {
    expect(() => cancelFollowUpSchema.parse({})).toThrow();
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await expect(move(w.cityManagerA.actor, id, "OPEN")).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("serializes concurrent completions: exactly one wins, the other is refused", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const results = await Promise.allSettled([complete(w.cityManagerA.actor, id), complete(w.stateManager.actor, id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(InvalidStateTransitionError);
    expect(await auditEvents(w.tenantId, "follow_up.status_change", id)).toHaveLength(1);
  });

  it("needs follow_ups.edit over the task and access to its target", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await expect(complete(w.cityManagerB.actor, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(complete(w.techA1.actor, id)).rejects.toBeInstanceOf(NotFoundError); // not theirs: not created by or given to them
    await expect(complete(w.finance.actor, id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("editing", () => {
  it("changes title, description, due date and priority of an open task and audits without free text", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const due = hoursFromNow(72);
    const view = await edit(w.cityManagerA.actor, id, { title: "Call the other number", description: "Evenings only", priority: "HIGH", dueAt: due });
    expect(view).toMatchObject({ title: "Call the other number", description: "Evenings only", priority: "HIGH" });
    const audit = (await auditEvents(w.tenantId, "follow_up.update", id))[0];
    expect(JSON.stringify(audit)).not.toContain("Evenings only");
    expect(audit.newValue).toMatchObject({ priority: "HIGH", title: "[text]" });
  });

  it("is a no-op (no audit) when nothing changes, and rejects an empty patch", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, title: "Same" });
    await edit(w.cityManagerA.actor, id, { title: "Same" });
    expect(await auditEvents(w.tenantId, "follow_up.update", id)).toHaveLength(0);
    expect(() => updateFollowUpSchema.parse({})).toThrow();
  });

  it("refuses to edit a finished task and starts a fresh reminder cycle when the due date moves", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await withTenant(w.tenantId, (tx) => tx.followUpTask.update({ where: { id }, data: { dueSoonNotifiedAt: new Date(), overdueNotifiedAt: new Date() } }));
    await edit(w.cityManagerA.actor, id, { dueAt: hoursFromNow(5) });
    expect(await followUpRow(w.tenantId, id)).toMatchObject({ dueSoonNotifiedAt: null, overdueNotifiedAt: null });
    await complete(w.cityManagerA.actor, id);
    await expect(edit(w.cityManagerA.actor, id, { title: "Too late" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});
