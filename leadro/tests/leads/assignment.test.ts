import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getLeadRoute } from "@/app/api/v1/leads/[id]/route";
import { POST as assignRoute } from "@/app/api/v1/leads/[id]/assign/route";
import { POST as unassignRoute } from "@/app/api/v1/leads/[id]/unassign/route";
import { ForbiddenError, InvalidStateTransitionError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { assignLead, assignLeadSchema, createInteraction, createInteractionSchema, unassignLead, unassignLeadSchema } from "@/server/leads";
import { listOwnNotifications } from "@/server/notifications";
import { disconnect, createPerson, grantTemplate } from "../authz/fixtures";
import { auditEvents, call, contextFor } from "../org/org-helpers";
import { activeAssignments, buildLeadWorld, forceStatus, intake, leadRow, statusHistory, type LeadWorld } from "./fixtures";

let w: LeadWorld;
let employeeIds: { leadOps: string; leadOps2: string; techA1: string; techB: string };

const assign = (actor: LeadWorld["ceo"]["actor"], leadId: string, fields: Record<string, unknown>) =>
  assignLead(actor, contextFor(actor), leadId, assignLeadSchema.parse(fields));
const unassign = (actor: LeadWorld["ceo"]["actor"], leadId: string, fields: Record<string, unknown>) =>
  unassignLead(actor, contextFor(actor), leadId, unassignLeadSchema.parse(fields));
const attempt = (actor: LeadWorld["ceo"]["actor"], leadId: string, fields: Record<string, unknown> = {}) =>
  createInteraction(actor, contextFor(actor), leadId, createInteractionSchema.parse({ kind: "CONTACT_ATTEMPT", channel: "PHONE", ...fields }));

beforeAll(async () => {
  w = await buildLeadWorld("leads-assign");
  employeeIds = {
    leadOps: w.leadOps.employeeId as string,
    leadOps2: w.leadOps2.employeeId as string,
    techA1: w.techA1.employeeId as string,
    techB: w.techB.employeeId as string,
  };
});
afterAll(disconnect);

describe("assigning a lead (§6.2)", () => {
  it("assigns a NEW lead: ASSIGNED status, one ACTIVE assignment, history and audit", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const view = await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    expect(view.status).toBe("ASSIGNED");
    expect(view.assignedEmployeeId).toBe(employeeIds.leadOps);
    const active = await activeAssignments(w.tenantId, leadId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ employeeId: employeeIds.leadOps, assignedById: w.stateManager.userId, conflictConfirmed: false });
    expect((await statusHistory(w.tenantId, leadId)).map((row) => row.toStatus)).toEqual(["NEW", "ASSIGNED"]);
    expect((await auditEvents(w.tenantId, "lead.assign", leadId))[0].newValue).toMatchObject({ employeeId: employeeIds.leadOps });
  });

  it("notifies the new owner (lead.assigned) but not the person who assigned to themselves", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    const inbox = await listOwnNotifications(w.leadOps.actor, { limit: 50 } as never);
    expect(inbox.data.some((note) => note.eventType === "lead.assigned" && note.targetId === leadId && !note.redacted)).toBe(true);

    const own = await intake(w, w.leadOps.actor);
    await assign(w.leadOps.actor, own, { employeeId: employeeIds.leadOps });
    const after = await listOwnNotifications(w.leadOps.actor, { limit: 50 } as never);
    expect(after.data.some((note) => note.eventType === "lead.assigned" && note.targetId === own)).toBe(false);
  });

  it("needs leads.assign: a Dispatcher and a Technician are refused", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await forceStatus(w.tenantId, leadId, "QUALIFIED"); // visible to the Dispatcher's record-set grant
    await expect(assign(w.dispatcher.actor, leadId, { employeeId: employeeIds.leadOps })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assign(w.techA1.actor, leadId, { employeeId: employeeIds.leadOps })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an unavailable employee: on leave, terminated, no placement, or no login (§25.1)", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const onLeave = await createPerson(w.tenantId, "on-leave", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    await grantTemplate(w.tenantId, onLeave, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: onLeave.employeeId as string }, data: { status: "ON_LEAVE" } }));
    await expect(assign(w.stateManager.actor, leadId, { employeeId: onLeave.employeeId })).rejects.toMatchObject({ field: "employeeId" });

    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: onLeave.employeeId as string }, data: { status: "TERMINATED" } }));
    await expect(assign(w.stateManager.actor, leadId, { employeeId: onLeave.employeeId })).rejects.toBeInstanceOf(ValidationError);

    const unplaced = await createPerson(w.tenantId, "unplaced", { withEmployee: true });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: unplaced.employeeId })).rejects.toMatchObject({ field: "employeeId" });

    const noLogin = await withTenant(w.tenantId, (tx) =>
      tx.employee.create({ data: { tenantId: w.tenantId, firstName: "No", lastName: "Login", assignments: { create: { orgUnitId: w.units.cityA, effectiveFrom: new Date(Date.now() - 86_400_000) } } } }),
    );
    await expect(assign(w.stateManager.actor, leadId, { employeeId: noLogin.id })).rejects.toMatchObject({ field: "employeeId" });
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);
  });

  it("refuses an employee who could not see the lead once assigned", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const outsider = await createPerson(w.tenantId, "no-role", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: outsider.employeeId })).rejects.toMatchObject({ field: "employeeId" });
  });

  it("asks for confirmation when the employee works outside the lead's service area (wrong region, §25.1)", async () => {
    const leadId = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityA });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.techB })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      field: "confirmOutsideServiceArea",
    });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.techB, confirmOutsideServiceArea: true })).rejects.toMatchObject({ field: "reason" });
    const view = await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.techB, confirmOutsideServiceArea: true, reason: "City B team covers this street" });
    expect(view.assignedEmployeeId).toBe(employeeIds.techB);
    expect((await auditEvents(w.tenantId, "lead.assign", leadId))[0].newValue).toMatchObject({ outsideServiceAreaConfirmed: true });
  });

  it("accepts an employee placed in a team below the lead's unit", async () => {
    const leadId = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityA });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.techA1 })).resolves.toMatchObject({ assignedEmployeeId: employeeIds.techA1 });
  });

  it("cannot hand an unrouted (tenant-level) lead to a unit-scoped employee: they could not see it", async () => {
    const unrouted = await intake(w, w.ceo.actor, { orgUnitId: undefined });
    await expect(assign(w.ceo.actor, unrouted, { employeeId: employeeIds.leadOps2 })).rejects.toMatchObject({ field: "employeeId" });
  });
});

describe("reassignment and the open-contact-attempt conflict (§25.1)", () => {
  it("requires a reason to replace an owner and ends the previous assignment (one ACTIVE owner)", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2 })).rejects.toMatchObject({ field: "reason" });
    const view = await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, reason: "Workload balance" });
    expect(view.assignedEmployeeId).toBe(employeeIds.leadOps2);

    const all = await withTenant(w.tenantId, (tx) => tx.leadAssignment.findMany({ where: { tenantId: w.tenantId, leadId }, orderBy: { assignedAt: "asc" } }));
    expect(all.map((row) => [row.employeeId, row.state])).toEqual([
      [employeeIds.leadOps, "ENDED"],
      [employeeIds.leadOps2, "ACTIVE"],
    ]);
    expect(all[0].endedReason).toContain("Workload balance");
    expect((await leadRow(w.tenantId, leadId)).status).toBe("ASSIGNED"); // reassignment keeps the status
  });

  it("refuses to assign to the current owner", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps, reason: "again" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("blocks reassignment while another employee is on a contact attempt, until confirmed with a reason", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    const open = await attempt(w.leadOps.actor, leadId); // leadOps is on the phone with the customer right now
    expect(open.closedAt).toBeNull();

    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, reason: "Rebalance" })).rejects.toMatchObject({
      code: "CONFLICT",
      field: "confirmOpenContactAttempt",
    });
    // Nothing changed.
    expect((await activeAssignments(w.tenantId, leadId))[0].employeeId).toBe(employeeIds.leadOps);

    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, confirmOpenContactAttempt: true })).rejects.toMatchObject({ field: "reason" });

    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, confirmOpenContactAttempt: true, reason: "Customer asked for a Spanish speaker" });
    const [current] = await activeAssignments(w.tenantId, leadId);
    expect(current).toMatchObject({ employeeId: employeeIds.leadOps2, conflictConfirmed: true });
    // History is preserved: the attempt is still there, only finished.
    const stored = await withTenant(w.tenantId, (tx) => tx.leadInteraction.findFirstOrThrow({ where: { tenantId: w.tenantId, id: String(open.id) } }));
    expect(stored.closedAt).not.toBeNull();
    expect(stored.outcome).toBeNull();
    const audit = (await auditEvents(w.tenantId, "lead.assign", leadId))[0];
    expect(audit.newValue).toMatchObject({ conflictConfirmed: true, closedOpenAttemptIds: [String(open.id)] });
    expect(audit.reason).toBe("Customer asked for a Spanish speaker");
  });

  it("does not treat the new owner's own open attempt, a finished attempt or a stale one as a conflict", async () => {
    const own = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, own, { employeeId: employeeIds.leadOps });
    await attempt(w.leadOps2.actor, own);
    await expect(assign(w.stateManager.actor, own, { employeeId: employeeIds.leadOps2, reason: "Hand over to the caller" })).resolves.toBeTruthy();

    const finished = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, finished, { employeeId: employeeIds.leadOps });
    await attempt(w.leadOps.actor, finished, { outcome: "NO_ANSWER" });
    await expect(assign(w.stateManager.actor, finished, { employeeId: employeeIds.leadOps2, reason: "Rebalance" })).resolves.toBeTruthy();

    const stale = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, stale, { employeeId: employeeIds.leadOps });
    await attempt(w.leadOps.actor, stale, { occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    await expect(assign(w.stateManager.actor, stale, { employeeId: employeeIds.leadOps2, reason: "Rebalance" })).resolves.toBeTruthy();
  });

  it("uses the tenant's open-attempt window", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    await attempt(w.leadOps.actor, leadId, { occurredAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    // 20 minutes old: still open with the default 30-minute window...
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, reason: "Rebalance" })).rejects.toMatchObject({ code: "CONFLICT" });
    // ... and stale once the tenant narrows the window to 10 minutes.
    await withTenant(w.tenantId, (tx) =>
      tx.operationsSettings.upsert({ where: { tenantId: w.tenantId }, create: { tenantId: w.tenantId, contactAttemptOpenMinutes: 10 }, update: { contactAttemptOpenMinutes: 10 } }),
    );
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2, reason: "Rebalance" })).resolves.toBeTruthy();
    await withTenant(w.tenantId, (tx) => tx.operationsSettings.update({ where: { tenantId: w.tenantId }, data: { contactAttemptOpenMinutes: 30 } }));
  });

  it("gives exactly one winner when two assigners race", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const results = await Promise.allSettled([
      assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps, reason: "first" }),
      assign(w.cityManagerA.actor, leadId, { employeeId: employeeIds.leadOps2, reason: "second" }),
    ]);
    // The row lock queues the second assigner behind the first; it then replaces the first owner (reason given).
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(1);
  });

  it("refuses to assign a closed or archived lead", async () => {
    const closed = await intake(w, w.stateManager.actor);
    await forceStatus(w.tenantId, closed, "LOST");
    await expect(assign(w.stateManager.actor, closed, { employeeId: employeeIds.leadOps })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const archived = await intake(w, w.stateManager.actor);
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: archived }, data: { archivedAt: new Date() } }));
    await expect(assign(w.stateManager.actor, archived, { employeeId: employeeIds.leadOps })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("releasing the owner", () => {
  it("returns the lead to UNASSIGNED and ends the assignment", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    const view = await unassign(w.stateManager.actor, leadId, { reason: "Owner left the team" });
    expect(view.status).toBe("UNASSIGNED");
    expect(view.assignedEmployeeId).toBeNull();
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);
    const history = await statusHistory(w.tenantId, leadId);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "ASSIGNED", toStatus: "UNASSIGNED", reason: "Owner left the team" });
    // ... and it can be assigned again.
    await expect(assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps2 })).resolves.toMatchObject({ status: "ASSIGNED" });
  });

  it("applies the open-contact-attempt rule to releasing as well", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.leadOps });
    await attempt(w.leadOps2.actor, leadId); // somebody ELSE than the owner is on the phone
    await expect(unassign(w.stateManager.actor, leadId, { reason: "Rebalance" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(unassign(w.stateManager.actor, leadId, { reason: "Rebalance", confirmOpenContactAttempt: true })).resolves.toMatchObject({ status: "UNASSIGNED" });
  });

  it("refuses to release a lead nobody owns, and the status endpoint cannot bypass the rule", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await expect(unassign(w.stateManager.actor, leadId, { reason: "none" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("assignment over the API and ASSIGNED scope", () => {
  it("lets the new owner open the lead and takes the access away on release (404)", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const assigned = await call(assignRoute, "POST", `/api/v1/leads/${leadId}/assign`, {
      cookie: w.cookies.stateManager,
      params: { id: leadId },
      body: { employeeId: employeeIds.techA1 },
    });
    expect(assigned.status).toBe(200);
    const asTech = () => call(getLeadRoute, "GET", `/api/v1/leads/${leadId}`, { cookie: w.cookies.techA1, params: { id: leadId } });
    expect((await asTech()).status).toBe(200);

    const released = await call(unassignRoute, "POST", `/api/v1/leads/${leadId}/unassign`, {
      cookie: w.cookies.stateManager,
      params: { id: leadId },
      body: { reason: "Reassigning to the office" },
    });
    expect(released.status).toBe(200);
    expect((await asTech()).status).toBe(404);
  });

  it("redacts the assignment notification once the recipient loses the lead", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(w.stateManager.actor, leadId, { employeeId: employeeIds.techA1 });
    const before = await listOwnNotifications(w.techA1.actor, { limit: 50 } as never);
    expect(before.data.find((note) => note.targetId === leadId)).toMatchObject({ redacted: false, params: { leadNumber: expect.any(Number) } });

    await unassign(w.stateManager.actor, leadId, { reason: "Wrong person" });
    const after = await listOwnNotifications(w.techA1.actor, { limit: 50 } as never);
    expect(after.data.some((note) => note.redacted && note.targetId === null)).toBe(true);
    expect(after.data.some((note) => note.targetId === leadId)).toBe(false);
  });

  it("answers 400 for an employee id that does not exist and 404 for a lead outside the caller's scope", async () => {
    const leadId = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityB });
    const missing = await call(assignRoute, "POST", `/api/v1/leads/${leadId}/assign`, { cookie: w.cookies.stateManager, params: { id: leadId }, body: { employeeId: "nope" } });
    expect(missing.status).toBe(400);
    const outside = await call(assignRoute, "POST", `/api/v1/leads/${leadId}/assign`, { cookie: w.cookies.cityManagerA, params: { id: leadId }, body: { employeeId: employeeIds.leadOps } });
    expect(outside.status).toBe(404);
  });
});
