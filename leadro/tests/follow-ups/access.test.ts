import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  assignFollowUp,
  assignFollowUpSchema,
  createFollowUp,
  createFollowUpSchema,
  getFollowUp,
  listFollowUps,
  listFollowUpsQuerySchema,
} from "@/server/follow-ups";
import { listOwnNotifications } from "@/server/notifications";
import { disconnect } from "../authz/fixtures";
import { makeCustomer, makeJob, makeLead } from "../customers/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";
import { buildFollowUpWorld, followUpRow, hoursFromNow, makeFollowUp, type FollowUpWorld } from "./fixtures";

let w: FollowUpWorld;
let techA1: string;
let techA1Other: string;
let techB: string;

const create = (actor: FollowUpWorld["ceo"]["actor"], fields: Record<string, unknown>) =>
  createFollowUp(actor, contextFor(actor), createFollowUpSchema.parse({ title: "Call back", dueAt: hoursFromNow(24), ...fields }));
const assign = (actor: FollowUpWorld["ceo"]["actor"], followUpId: string, assigneeId: string | null) =>
  assignFollowUp(actor, contextFor(actor), followUpId, assignFollowUpSchema.parse({ assigneeId }));
const list = (actor: FollowUpWorld["ceo"]["actor"], query: Record<string, unknown> = {}) =>
  listFollowUps(actor, listFollowUpsQuerySchema.parse(query));
const idsOf = (page: { data: Array<Record<string, unknown>> }) => page.data.map((row) => String(row.id));

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-access");
  techA1 = w.techA1.employeeId as string;
  techA1Other = w.techA1Other.employeeId as string;
  techB = w.techB.employeeId as string;
});
afterAll(disconnect);

describe("creating a follow-up", () => {
  it("copies the target's service area, defaults to MANUAL / NORMAL, audits without free text", async () => {
    const view = await create(w.cityManagerA.actor, { targetType: "LEAD", targetId: w.leadA, title: "Secret customer detail", description: "Private" });
    expect(view).toMatchObject({ targetType: "LEAD", leadId: w.leadA, orgUnitId: w.units.cityA, status: "OPEN", priority: "NORMAL", origin: "MANUAL", assigneeId: null, overdue: false });
    expect(view.nextStatuses).toEqual(["IN_PROGRESS", "DONE", "CANCELLED"]);
    const audit = (await auditEvents(w.tenantId, "follow_up.create", String(view.id)))[0];
    expect(audit.actorUserId).toBe(w.cityManagerA.userId);
    expect(JSON.stringify(audit.newValue)).not.toContain("Secret customer detail");
  });

  it("works for every real target type", async () => {
    for (const [targetType, targetId] of [["CUSTOMER", w.customerA], ["JOB", w.jobA], ["LEAD", w.leadA]] as const) {
      const view = await create(w.cityManagerA.actor, { targetType, targetId });
      expect(view.targetType).toBe(targetType);
    }
  });

  it("answers 404 for a target outside the creator's scope, a missing one, and another tenant's", async () => {
    await expect(create(w.cityManagerA.actor, { targetType: "LEAD", targetId: w.leadB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(w.cityManagerA.actor, { targetType: "LEAD", targetId: "does-not-exist" })).rejects.toBeInstanceOf(NotFoundError);
    const other = await buildFollowUpWorld("followups-access-other");
    await expect(create(w.ceo.actor, { targetType: "JOB", targetId: other.jobA })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an archived target only to people who can see it", async () => {
    const archivedLead = await makeLead(w.tenantId, w.customerA, { orgUnitId: w.units.cityA, archived: true });
    await expect(create(w.cityManagerA.actor, { targetType: "LEAD", targetId: archivedLead })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(create(w.cityManagerB.actor, { targetType: "LEAD", targetId: archivedLead })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("needs follow_ups.create: a Finance Director holds no follow-up permission", async () => {
    await expect(create(w.finance.actor, { targetType: "JOB", targetId: w.jobA })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a technician follow up their own assigned job and lead, and nothing else", async () => {
    const own = await create(w.techA1.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1 });
    expect(own).toMatchObject({ assigneeId: techA1, createdById: w.techA1.userId });
    await expect(create(w.techA1.actor, { targetType: "JOB", targetId: w.jobB })).rejects.toBeInstanceOf(NotFoundError);
    const unassignedJob = await makeJob(w.tenantId, w.customerA, w.units.cityA);
    await expect(create(w.techA1.actor, { targetType: "JOB", targetId: unassignedJob })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("gives a Dispatcher no way to reach a lead that has not reached dispatch (the target gate)", async () => {
    // follow_ups covers the whole state for the Dispatcher, but leads.view is limited to the dispatch_related set.
    await expect(create(w.dispatcher.actor, { targetType: "LEAD", targetId: w.leadA })).rejects.toBeInstanceOf(NotFoundError);
    expect(await create(w.dispatcher.actor, { targetType: "JOB", targetId: w.jobA })).toMatchObject({ targetType: "JOB" });
  });
});

describe("assignment scope (the assignee must be within the creator's employee scope)", () => {
  it("lets a City Manager assign to an employee under their unit and notifies them, once", async () => {
    const view = await create(w.cityManagerA.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1 });
    expect(view.assigneeId).toBe(techA1);
    const inbox = await listOwnNotifications(w.techA1.actor, { limit: 50 } as never);
    const note = inbox.data.find((entry) => entry.eventType === "follow_up.assigned" && entry.targetId === view.id);
    expect(note).toMatchObject({ templateKey: "NOTIFICATION.FOLLOW_UP_ASSIGNED", redacted: false });
  });

  it("answers an employee outside the creator's scope exactly like a missing one", async () => {
    await expect(create(w.cityManagerA.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: techB })).rejects.toMatchObject({ field: "assigneeId" });
    await expect(create(w.cityManagerA.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: "no-such-employee" })).rejects.toMatchObject({ field: "assigneeId" });
  });

  it("refuses giving a task to somebody else without follow_ups.assign", async () => {
    await expect(create(w.techA1.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1Other })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an assignee who could not open the task's target (no silent dead-letter tasks)", async () => {
    // techA1Other works nothing: the lead and job are assigned to techA1 only.
    await expect(create(w.cityManagerA.actor, { targetType: "LEAD", targetId: w.leadA, assigneeId: techA1Other })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses an employee on leave", async () => {
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: techA1Other }, data: { status: "ON_LEAVE" } }));
    await expect(create(w.cityManagerA.actor, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1Other })).rejects.toBeInstanceOf(ValidationError);
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: techA1Other }, data: { status: "ACTIVE" } }));
  });

  it("assigns and unassigns, auditing both", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const assigned = await assign(w.cityManagerA.actor, id, techA1);
    expect(assigned).toMatchObject({ assigneeId: techA1 });
    expect((await followUpRow(w.tenantId, id)).assignedAt).not.toBeNull();
    const cleared = await assign(w.cityManagerA.actor, id, null);
    expect(cleared).toMatchObject({ assigneeId: null });
    expect((await auditEvents(w.tenantId, "follow_up.assign", id))[0].newValue).toMatchObject({ assigneeId: techA1 });
    expect(await auditEvents(w.tenantId, "follow_up.unassign", id)).toHaveLength(1);
  });

  it("needs follow_ups.assign: a Technician and a Dispatcher cannot assign", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1 });
    await expect(assign(w.techA1.actor, id, techA1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assign(w.dispatcher.actor, id, techA1)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("reading: both gates apply to single records and lists", () => {
  let cityATask: string;
  let cityBTask: string;
  let techTask: string;
  let otherTechTask: string;

  beforeAll(async () => {
    cityATask = await makeFollowUp(w.cityManagerA, { targetType: "LEAD", targetId: w.leadA, title: "City A lead" });
    cityBTask = await makeFollowUp(w.cityManagerB, { targetType: "LEAD", targetId: w.leadB, title: "City B lead" });
    techTask = await makeFollowUp(w.techA1, { targetType: "JOB", targetId: w.jobA, assigneeId: techA1, title: "Tech's own" });
    otherTechTask = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA, title: "Nobody's" });
  });

  it("scopes managers to their unit, a State Manager to both cities and the Owner to everything", async () => {
    expect(idsOf(await list(w.cityManagerA.actor))).toEqual(expect.arrayContaining([cityATask]));
    expect(idsOf(await list(w.cityManagerA.actor))).not.toContain(cityBTask);
    expect(idsOf(await list(w.cityManagerB.actor))).toContain(cityBTask);
    expect(idsOf(await list(w.cityManagerB.actor))).not.toContain(cityATask);
    const state = idsOf(await list(w.stateManager.actor, { limit: 200 }));
    expect(state).toEqual(expect.arrayContaining([cityATask, cityBTask]));
    expect(idsOf(await list(w.ceo.actor, { limit: 200 }))).toEqual(expect.arrayContaining([cityATask, cityBTask, techTask]));
  });

  it("shows a Technician what they created or were given, never a colleague's tasks", async () => {
    const mine = idsOf(await list(w.techA1.actor, { limit: 200 }));
    expect(mine).toContain(techTask);
    expect(mine).not.toContain(cityBTask);
    expect(mine).not.toContain(otherTechTask); // same job, but created by a manager and given to nobody
    expect(idsOf(await list(w.techB.actor, { limit: 200 }))).not.toContain(techTask);
  });

  it("answers 404 for a single task outside either gate", async () => {
    await expect(getFollowUp(w.cityManagerA.actor, cityBTask)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getFollowUp(w.techB.actor, techTask)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getFollowUp(w.techA1.actor, otherTechTask)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getFollowUp(w.finance.actor, cityATask)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides a task whose target the viewer cannot see even when the task scope covers it", async () => {
    // The Dispatcher's follow_ups scope is the whole state, but leads reach them only once dispatch-related.
    expect(idsOf(await list(w.dispatcher.actor, { limit: 200 }))).not.toContain(cityATask);
    await expect(getFollowUp(w.dispatcher.actor, cityATask)).rejects.toBeInstanceOf(NotFoundError);
    expect(idsOf(await list(w.dispatcher.actor, { limit: 200 }))).toContain(otherTechTask);
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: w.leadA }, data: { status: "QUALIFIED" } }));
    expect(idsOf(await list(w.dispatcher.actor, { limit: 200 }))).toContain(cityATask);
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: w.leadA }, data: { status: "NEW" } }));
  });

  it("hides tasks once the viewer loses the target (a technician unassigned from the job)", async () => {
    const job = await makeJob(w.tenantId, w.customerA, w.units.cityA);
    await withTenant(w.tenantId, (tx) =>
      tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job, employeeId: techA1, state: "ACTIVE", assignedAt: new Date() } }),
    );
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: job, assigneeId: techA1 });
    expect(idsOf(await list(w.techA1.actor, { limit: 200 }))).toContain(id);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.updateMany({ where: { jobId: job }, data: { state: "ENDED", endedAt: new Date() } }));
    expect(idsOf(await list(w.techA1.actor, { limit: 200 }))).not.toContain(id);
    await expect(getFollowUp(w.techA1.actor, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters by target, assignee, overdue and status, and keeps pages stable", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const lead = await makeLead(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
    const early = await makeFollowUp(w.cityManagerA, { targetType: "LEAD", targetId: lead, dueAt: hoursFromNow(1) });
    const late = await makeFollowUp(w.cityManagerA, { targetType: "LEAD", targetId: lead, dueAt: hoursFromNow(48) });
    const past = await makeFollowUp(w.cityManagerA, { targetType: "LEAD", targetId: lead, dueAt: hoursFromNow(-2) });
    const forTarget = await list(w.cityManagerA.actor, { targetType: "LEAD", targetId: lead });
    expect(idsOf(forTarget)).toEqual([past, early, late]); // soonest due first
    expect(forTarget.data[0].overdue).toBe(true);
    expect(idsOf(await list(w.cityManagerA.actor, { targetType: "LEAD", targetId: lead, overdue: "true" }))).toEqual([past]);

    const firstPage = await list(w.cityManagerA.actor, { targetType: "LEAD", targetId: lead, limit: 2 });
    expect(firstPage.page.nextCursor).not.toBeNull();
    const secondPage = await list(w.cityManagerA.actor, { targetType: "LEAD", targetId: lead, limit: 2, cursor: firstPage.page.nextCursor });
    expect([...idsOf(firstPage), ...idsOf(secondPage)]).toEqual([past, early, late]);

    await assign(w.cityManagerA.actor, early, techA1).catch(() => undefined); // lead has no worker: refused, stays unassigned
    expect(idsOf(await list(w.cityManagerA.actor, { targetType: "LEAD", targetId: lead, unassigned: "true" }))).toHaveLength(3);
    expect(idsOf(await list(w.cityManagerA.actor, { assigneeEmployeeId: "me" }))).toEqual([]);
    await expect(list(w.cityManagerA.actor, { targetId: lead })).rejects.toBeInstanceOf(ValidationError);
  });
});
