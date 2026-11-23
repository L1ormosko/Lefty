import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import {
  completeFollowUp,
  completeFollowUpSchema,
  sweepAllFollowUps,
  sweepFollowUps,
  updateFollowUp,
  updateFollowUpSchema,
} from "@/server/follow-ups";
import { listOwnNotifications } from "@/server/notifications";
import { disconnect } from "../authz/fixtures";
import { makeJob } from "../customers/fixtures";
import { contextFor } from "../org/org-helpers";
import { buildFollowUpWorld, followUpRow, hoursFromNow, makeFollowUp, setDueAt, type FollowUpWorld } from "./fixtures";

let w: FollowUpWorld;

/** The follow-up notifications of one task that a person holds. */
async function notificationsFor(person: FollowUpWorld["techA1"], followUpId: string, eventType: string) {
  const inbox = await listOwnNotifications(person.actor, { limit: 200 } as never);
  return inbox.data.filter((entry) => entry.eventType === eventType && entry.targetId === followUpId);
}

const assignedToTech = (extra: Record<string, unknown> = {}) =>
  makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: w.techA1.employeeId, ...extra });

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-sweep");
});
afterAll(disconnect);

describe("the follow-up sweep", () => {
  it("notifies the assignee once when a task comes due soon (default window: 60 minutes)", async () => {
    const soon = await assignedToTech({ dueAt: hoursFromNow(0.5) });
    const later = await assignedToTech({ dueAt: hoursFromNow(5) });
    const result = await sweepFollowUps(w.tenantId);
    expect(result.dueSoon).toBeGreaterThanOrEqual(1);
    const notes = await notificationsFor(w.techA1, soon, "follow_up.due_soon");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ templateKey: "NOTIFICATION.FOLLOW_UP_DUE_SOON", redacted: false });
    expect(await notificationsFor(w.techA1, later, "follow_up.due_soon")).toHaveLength(0);
    expect((await followUpRow(w.tenantId, soon)).dueSoonNotifiedAt).not.toBeNull();

    await sweepFollowUps(w.tenantId); // running again changes nothing
    expect(await notificationsFor(w.techA1, soon, "follow_up.due_soon")).toHaveLength(1);
  });

  it("raises overdue once, and an overdue task never also gets a due-soon notice", async () => {
    const id = await assignedToTech();
    await setDueAt(w.tenantId, id, hoursFromNow(-3));
    await sweepFollowUps(w.tenantId);
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, id, "follow_up.overdue")).toHaveLength(1);
    expect(await notificationsFor(w.techA1, id, "follow_up.due_soon")).toHaveLength(0);
    expect((await followUpRow(w.tenantId, id)).overdueNotifiedAt).not.toBeNull();
  });

  it("reports the real counts and honours a custom due-soon window", async () => {
    const id = await assignedToTech({ dueAt: hoursFromNow(3) });
    await withTenant(w.tenantId, (tx) => tx.operationsSettings.upsert({ where: { tenantId: w.tenantId }, create: { tenantId: w.tenantId, followUpDueSoonMinutes: 240 }, update: { followUpDueSoonMinutes: 240 } }));
    const result = await sweepFollowUps(w.tenantId);
    expect(result.dueSoon).toBeGreaterThanOrEqual(1);
    expect(await notificationsFor(w.techA1, id, "follow_up.due_soon")).toHaveLength(1);
    await withTenant(w.tenantId, (tx) => tx.operationsSettings.update({ where: { tenantId: w.tenantId }, data: { followUpDueSoonMinutes: 60 } }));
  });

  it("is driven by the clock it is given", async () => {
    const id = await assignedToTech({ dueAt: hoursFromNow(10) });
    await sweepFollowUps(w.tenantId, hoursFromNow(9.5));
    expect(await notificationsFor(w.techA1, id, "follow_up.due_soon")).toHaveLength(1);
    await sweepFollowUps(w.tenantId, hoursFromNow(11));
    expect(await notificationsFor(w.techA1, id, "follow_up.overdue")).toHaveLength(1);
  });

  it("leaves finished, cancelled and unassigned tasks alone, and picks the unassigned one up once it has an owner", async () => {
    const done = await assignedToTech();
    await completeFollowUp(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), done, completeFollowUpSchema.parse({}));
    await setDueAt(w.tenantId, done, hoursFromNow(-5));
    const unassigned = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    await setDueAt(w.tenantId, unassigned, hoursFromNow(-5));
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, done, "follow_up.overdue")).toHaveLength(0);
    expect((await followUpRow(w.tenantId, unassigned)).overdueNotifiedAt).toBeNull();

    await withTenant(w.tenantId, (tx) => tx.followUpTask.update({ where: { id: unassigned }, data: { assigneeId: w.techA1.employeeId, assignedAt: new Date() } }));
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, unassigned, "follow_up.overdue")).toHaveLength(1);
  });

  it("gives a moved due date its own reminders", async () => {
    const id = await assignedToTech({ dueAt: hoursFromNow(0.2) });
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, id, "follow_up.due_soon")).toHaveLength(1);
    await updateFollowUp(w.cityManagerA.actor, contextFor(w.cityManagerA.actor), id, updateFollowUpSchema.parse({ dueAt: hoursFromNow(0.4) }));
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, id, "follow_up.due_soon")).toHaveLength(2);
  });

  it("claims each task once even when sweeps run at the same time", async () => {
    const id = await assignedToTech();
    await setDueAt(w.tenantId, id, hoursFromNow(-1));
    await Promise.all([sweepFollowUps(w.tenantId), sweepFollowUps(w.tenantId), sweepFollowUps(w.tenantId)]);
    expect(await notificationsFor(w.techA1, id, "follow_up.overdue")).toHaveLength(1);
  });

  it("claims but does not notify an assignee who lost access to the target, so it cannot loop", async () => {
    const job = await makeJob(w.tenantId, w.customerA, w.units.cityA);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job, employeeId: w.techA1.employeeId as string, state: "ACTIVE", assignedAt: new Date() } }));
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: job, assigneeId: w.techA1.employeeId });
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.updateMany({ where: { jobId: job }, data: { state: "ENDED", endedAt: new Date() } }));
    await setDueAt(w.tenantId, id, hoursFromNow(-1));
    await sweepFollowUps(w.tenantId);
    expect(await notificationsFor(w.techA1, id, "follow_up.overdue")).toHaveLength(0);
    expect((await followUpRow(w.tenantId, id)).overdueNotifiedAt).not.toBeNull();
  });

  it("sweeps only the tenants asked for and isolates tenants from each other", async () => {
    const other = await buildFollowUpWorld("followups-sweep-other");
    const otherTask = await makeFollowUp(other.cityManagerA, { targetType: "JOB", targetId: other.jobA, assigneeId: other.techA1.employeeId });
    await setDueAt(other.tenantId, otherTask, hoursFromNow(-2));
    const mine = await assignedToTech();
    await setDueAt(w.tenantId, mine, hoursFromNow(-2));
    await sweepAllFollowUps({ tenantIds: [w.tenantId] });
    expect((await followUpRow(w.tenantId, mine)).overdueNotifiedAt).not.toBeNull();
    expect((await followUpRow(other.tenantId, otherTask)).overdueNotifiedAt).toBeNull();
    await sweepAllFollowUps({ tenantIds: [other.tenantId] });
    expect((await followUpRow(other.tenantId, otherTask)).overdueNotifiedAt).not.toBeNull();
  });
});
