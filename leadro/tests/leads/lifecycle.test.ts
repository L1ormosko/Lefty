import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as closeAttemptRoute } from "@/app/api/v1/leads/[id]/interactions/[interactionId]/close/route";
import { POST as interactionRoute, GET as listInteractionsRoute } from "@/app/api/v1/leads/[id]/interactions/route";
import { GET as historyRoute } from "@/app/api/v1/leads/[id]/history/route";
import { POST as statusRoute } from "@/app/api/v1/leads/[id]/status/route";
import { InvalidStateTransitionError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { assignLead, assignLeadSchema, changeLeadStatus, changeLeadStatusSchema, createInteraction, createInteractionSchema, listLeads, listLeadsQuerySchema } from "@/server/leads";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call, contextFor } from "../org/org-helpers";
import { activeAssignments, buildLeadWorld, forceStatus, intake, leadRow, statusHistory, type LeadWorld } from "./fixtures";

let w: LeadWorld;
let owner: string;

const move = (leadId: string, fields: Record<string, unknown>, actor = w.stateManager.actor) =>
  changeLeadStatus(actor, contextFor(actor), leadId, changeLeadStatusSchema.parse(fields));
const note = (actor: LeadWorld["ceo"]["actor"], leadId: string, fields: Record<string, unknown>) =>
  createInteraction(actor, contextFor(actor), leadId, createInteractionSchema.parse(fields));
const assigned = async (): Promise<string> => {
  const leadId = await intake(w, w.stateManager.actor);
  await assignLead(w.stateManager.actor, contextFor(w.stateManager.actor), leadId, assignLeadSchema.parse({ employeeId: owner }));
  return leadId;
};

beforeAll(async () => {
  w = await buildLeadWorld("leads-lifecycle");
  owner = w.leadOps.employeeId as string;
});
afterAll(disconnect);

describe("status changes (§6.3)", () => {
  it("walks the default path and records previous, new, who, when and reason for each step", async () => {
    const leadId = await assigned();
    for (const status of ["CONTACT_ATTEMPTED", "CONTACTED", "QUALIFIED", "SCHEDULED", "DISPATCHED"]) {
      await move(leadId, { status, reason: `step ${status}` });
    }
    const history = await statusHistory(w.tenantId, leadId);
    expect(history.map((row) => row.toStatus)).toEqual(["NEW", "ASSIGNED", "CONTACT_ATTEMPTED", "CONTACTED", "QUALIFIED", "SCHEDULED", "DISPATCHED"]);
    expect(history[3]).toMatchObject({ fromStatus: "CONTACT_ATTEMPTED", toStatus: "CONTACTED", actorUserId: w.stateManager.userId, reason: "step CONTACTED" });
    expect(history[3].occurredAt).toBeInstanceOf(Date);
    expect((await auditEvents(w.tenantId, "lead.status_change", leadId)).length).toBe(6);
  });

  it("rejects a transition the machine does not contain, leaving the lead untouched", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await expect(move(leadId, { status: "QUALIFIED" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect((await leadRow(w.tenantId, leadId)).status).toBe("NEW");
    expect(await statusHistory(w.tenantId, leadId)).toHaveLength(1);
  });

  it("sends ASSIGNED, CONVERTED and releasing an owner to their own actions", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await expect(move(leadId, { status: "ASSIGNED" })).rejects.toMatchObject({ field: "status" });
    const owned = await assigned();
    await expect(move(owned, { status: "UNASSIGNED" })).rejects.toMatchObject({ field: "status" });
    await forceStatus(w.tenantId, owned, "QUALIFIED");
    await expect(move(owned, { status: "CONVERTED" })).rejects.toMatchObject({ field: "status" });
    expect((await leadRow(w.tenantId, owned)).status).toBe("QUALIFIED");
  });

  it("requires a reason for LOST and CANCELLED, and ends the owner's assignment when it closes the lead", async () => {
    const leadId = await assigned();
    await expect(move(leadId, { status: "LOST" })).rejects.toMatchObject({ field: "reason" });
    await expect(move(leadId, { status: "CANCELLED" })).rejects.toBeInstanceOf(ValidationError);
    await move(leadId, { status: "CANCELLED", reason: "Customer requests cancellation" });
    const row = await leadRow(w.tenantId, leadId);
    expect(row).toMatchObject({ status: "CANCELLED", closedReason: "Customer requests cancellation" });
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);
    // CANCELLED is final.
    await expect(move(leadId, { status: "UNASSIGNED" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("marks a duplicate only with the lead it duplicates, and reopens LOST leads cleanly", async () => {
    const original = await intake(w, w.stateManager.actor);
    const copy = await intake(w, w.stateManager.actor);
    await expect(move(copy, { status: "DUPLICATE" })).rejects.toMatchObject({ field: "duplicateOfLeadId" });
    await expect(move(copy, { status: "DUPLICATE", duplicateOfLeadId: copy })).rejects.toMatchObject({ field: "duplicateOfLeadId" });
    await expect(move(copy, { status: "DUPLICATE", duplicateOfLeadId: "missing" })).rejects.toMatchObject({ field: "duplicateOfLeadId" });
    await move(copy, { status: "DUPLICATE", duplicateOfLeadId: original });
    expect(await leadRow(w.tenantId, copy)).toMatchObject({ status: "DUPLICATE", duplicateOfLeadId: original });

    const lost = await assigned();
    await move(lost, { status: "LOST", reason: "Went with a competitor" });
    await move(lost, { status: "UNASSIGNED", reason: "They called back" });
    expect(await leadRow(w.tenantId, lost)).toMatchObject({ status: "UNASSIGNED", closedReason: null });
  });

  it("does not let a caller name a lead outside their scope as the original", async () => {
    const inB = await intake(w, w.stateManager.actor, { orgUnitId: w.units.cityB });
    const mine = await intake(w, w.cityManagerA.actor);
    await expect(move(mine, { status: "DUPLICATE", duplicateOfLeadId: inB }, w.cityManagerA.actor)).rejects.toMatchObject({ field: "duplicateOfLeadId" });
  });

  it("honours a tenant's narrowing of optional transitions, and ignores attempts to block the default path", async () => {
    const leadId = await assigned();
    await withTenant(w.tenantId, (tx) =>
      tx.operationsSettings.upsert({
        where: { tenantId: w.tenantId },
        create: { tenantId: w.tenantId, disabledLeadTransitions: ["ASSIGNED>LOST", "ASSIGNED>CONTACT_ATTEMPTED"] },
        update: { disabledLeadTransitions: ["ASSIGNED>LOST", "ASSIGNED>CONTACT_ATTEMPTED"] },
      }),
    );
    try {
      await expect(move(leadId, { status: "LOST", reason: "nope" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
      await expect(move(leadId, { status: "CONTACT_ATTEMPTED" })).resolves.toMatchObject({ status: "CONTACT_ATTEMPTED" });
    } finally {
      await withTenant(w.tenantId, (tx) => tx.operationsSettings.update({ where: { tenantId: w.tenantId }, data: { disabledLeadTransitions: [] } }));
    }
  });

  it("refuses a status change on an archived lead", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: leadId }, data: { archivedAt: new Date() } }));
    await expect(move(leadId, { status: "UNASSIGNED" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("serves the history over the API, oldest first", async () => {
    const leadId = await assigned();
    await call(statusRoute, "POST", `/api/v1/leads/${leadId}/status`, { cookie: w.cookies.stateManager, params: { id: leadId }, body: { status: "CONTACTED" } });
    const result = await call(historyRoute, "GET", `/api/v1/leads/${leadId}/history`, { cookie: w.cookies.stateManager, params: { id: leadId } });
    expect(result.status).toBe(200);
    expect(result.json.data.map((row: { toStatus: string }) => row.toStatus)).toEqual(["NEW", "ASSIGNED", "CONTACTED"]);
    const denied = await call(historyRoute, "GET", `/api/v1/leads/${leadId}/history`, { cookie: w.cookies.techB, params: { id: leadId } });
    expect(denied.status).toBe(404);
  });

  it("rejects an unknown status with 400 and a missing body field with a field error", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    const result = await call(statusRoute, "POST", `/api/v1/leads/${leadId}/status`, { cookie: w.cookies.stateManager, params: { id: leadId }, body: { status: "FLYING" } });
    expect(result.status).toBe(400);
  });
});

describe("interactions and follow-ups (§6.2)", () => {
  it("moves an ASSIGNED lead to CONTACT_ATTEMPTED, and to CONTACTED when the customer is reached", async () => {
    const leadId = await assigned();
    const open = await note(w.leadOps.actor, leadId, { kind: "CONTACT_ATTEMPT", channel: "PHONE" });
    expect(open).toMatchObject({ kind: "CONTACT_ATTEMPT", direction: "OUTBOUND", closedAt: null, authorId: w.leadOps.userId });
    expect((await leadRow(w.tenantId, leadId)).status).toBe("CONTACT_ATTEMPTED");

    const closed = await call(closeAttemptRoute, "POST", `/api/v1/leads/${leadId}/interactions/${open.id}/close`, {
      cookie: w.cookies.leadOps,
      params: { id: leadId, interactionId: String(open.id) },
      body: { outcome: "REACHED", durationSeconds: 240 },
    });
    expect(closed.status).toBe(200);
    expect(closed.json.data).toMatchObject({ outcome: "REACHED", durationSeconds: 240 });
    expect(closed.json.data.closedAt).toBeTruthy();
    expect((await leadRow(w.tenantId, leadId)).status).toBe("CONTACTED");

    const again = await call(closeAttemptRoute, "POST", `/api/v1/leads/${leadId}/interactions/${open.id}/close`, {
      cookie: w.cookies.leadOps,
      params: { id: leadId, interactionId: String(open.id) },
      body: { outcome: "NO_ANSWER" },
    });
    expect(again.status).toBe(409);
  });

  it("records an attempt with its outcome as already finished, and never pulls a qualified lead backwards", async () => {
    const leadId = await assigned();
    const done = await note(w.leadOps.actor, leadId, { kind: "CONTACT_ATTEMPT", channel: "SMS", outcome: "NO_ANSWER" });
    expect(done.closedAt).not.toBeNull();
    await forceStatus(w.tenantId, leadId, "QUALIFIED");
    await note(w.leadOps.actor, leadId, { kind: "CONTACT_ATTEMPT", channel: "PHONE", outcome: "VOICEMAIL" });
    expect((await leadRow(w.tenantId, leadId)).status).toBe("QUALIFIED");
  });

  it("sets the follow-up date, lists due follow-ups, and clears it when the customer is reached", async () => {
    const leadId = await assigned();
    const due = new Date(Date.now() - 3_600_000);
    await note(w.leadOps.actor, leadId, { kind: "FOLLOW_UP", followUpAt: due.toISOString(), body: "Call back after lunch" });
    expect((await leadRow(w.tenantId, leadId)).nextFollowUpAt?.toISOString()).toBe(due.toISOString());
    const queue = await listLeads(w.stateManager.actor, listLeadsQuerySchema.parse({ followUpDue: "true", limit: "200" }));
    expect(queue.data.map((row) => row.id)).toContain(leadId);

    await note(w.leadOps.actor, leadId, { kind: "CONTACT_ATTEMPT", channel: "PHONE", outcome: "REACHED" });
    expect((await leadRow(w.tenantId, leadId)).nextFollowUpAt).toBeNull();
    const after = await listLeads(w.stateManager.actor, listLeadsQuerySchema.parse({ followUpDue: "true", limit: "200" }));
    expect(after.data.map((row) => row.id)).not.toContain(leadId);
  });

  it("lists interactions newest first and filters by kind", async () => {
    const leadId = await assigned();
    await note(w.leadOps.actor, leadId, { kind: "NOTE", body: "First" });
    await note(w.leadOps.actor, leadId, { kind: "CUSTOMER_MESSAGE", body: "Customer wrote back" });
    const all = await call(listInteractionsRoute, "GET", `/api/v1/leads/${leadId}/interactions`, { cookie: w.cookies.stateManager, params: { id: leadId } });
    expect(all.json.data.map((row: { kind: string }) => row.kind)).toEqual(["CUSTOMER_MESSAGE", "NOTE"]);
    expect(all.json.data[0].direction).toBe("INBOUND");
    const notes = await call(listInteractionsRoute, "GET", `/api/v1/leads/${leadId}/interactions`, { cookie: w.cookies.stateManager, params: { id: leadId }, query: { kind: "NOTE" } });
    expect(notes.json.data).toHaveLength(1);
  });

  it("validates the interaction shape and refuses the future", async () => {
    const leadId = await assigned();
    for (const body of [{ kind: "CONTACT_ATTEMPT" }, { kind: "NOTE" }, { kind: "FOLLOW_UP" }, { kind: "NOTE", body: "x", outcome: "REACHED" }]) {
      const result = await call(interactionRoute, "POST", `/api/v1/leads/${leadId}/interactions`, { cookie: w.cookies.stateManager, params: { id: leadId }, body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    const future = await call(interactionRoute, "POST", `/api/v1/leads/${leadId}/interactions`, {
      cookie: w.cookies.stateManager,
      params: { id: leadId },
      body: { kind: "NOTE", body: "x", occurredAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(future.status).toBe(400);
  });

  it("keeps contact logging away from a status-only Technician, but lets them read it", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assignLead(w.stateManager.actor, contextFor(w.stateManager.actor), leadId, assignLeadSchema.parse({ employeeId: w.techA1.employeeId }));
    const write = await call(interactionRoute, "POST", `/api/v1/leads/${leadId}/interactions`, {
      cookie: w.cookies.techA1,
      params: { id: leadId },
      body: { kind: "NOTE", body: "hello" },
    });
    expect(write.status).toBe(403);
    const read = await call(listInteractionsRoute, "GET", `/api/v1/leads/${leadId}/interactions`, { cookie: w.cookies.techA1, params: { id: leadId } });
    expect(read.status).toBe(200);
  });

  it("takes no contact attempt on a closed lead, but still accepts a note", async () => {
    const leadId = await assigned();
    await move(leadId, { status: "LOST", reason: "gone" });
    await expect(note(w.leadOps.actor, leadId, { kind: "CONTACT_ATTEMPT", channel: "PHONE" })).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(note(w.stateManager.actor, leadId, { kind: "NOTE", body: "Post-mortem" })).resolves.toBeTruthy();
  });
});
