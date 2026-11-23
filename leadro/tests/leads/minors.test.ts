import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as restoreRoute } from "@/app/api/v1/leads/[id]/restore/route";
import { POST as archiveRoute } from "@/app/api/v1/leads/[id]/archive/route";
import { withTenant } from "@/server/db";
import {
  assignLead,
  assignLeadSchema,
  createInteraction,
  createInteractionSchema,
  createLead,
  createLeadSchema,
  listLeads,
  listLeadsQuerySchema,
  unassignLead,
  unassignLeadSchema,
} from "@/server/leads";
import { disconnect } from "../authz/fixtures";
import { call, contextFor } from "../org/org-helpers";
import { activeAssignments, buildLeadWorld, intake, leadRow, statusHistory, uniquePhone, type LeadWorld } from "./fixtures";

let w: LeadWorld;
beforeAll(async () => {
  w = await buildLeadWorld("leads-minors");
});
afterAll(disconnect);

const ctx = () => contextFor(w.stateManager.actor);
const assign = (leadId: string, employeeId: string) => assignLead(w.stateManager.actor, ctx(), leadId, assignLeadSchema.parse({ employeeId }));

/** Prisma logs the unique violations of a deliberate race to the console; keep the test output clean. */
function silenceConsole() {
  const spies = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  return () => spies.forEach((spy) => spy.mockRestore());
}

describe("list filters combine instead of overwriting", () => {
  it("assigned=false together with an assignee matches nothing; status and the follow-up queue both apply", async () => {
    const owned = await intake(w, w.stateManager.actor);
    await assign(owned, w.leadOps.employeeId as string);
    const query = (fields: Record<string, string>) => listLeads(w.stateManager.actor, listLeadsQuerySchema.parse({ limit: "200", ...fields }));
    expect((await query({ assigned: "false", assigneeEmployeeId: w.leadOps.employeeId as string })).data).toEqual([]);
    expect((await query({ assigned: "true", assigneeEmployeeId: w.leadOps.employeeId as string })).data.map((r) => r.id)).toContain(owned);

    await withTenant(w.tenantId, (tx) => tx.lead.update({ where: { id: owned }, data: { nextFollowUpAt: new Date(Date.now() - 1000) } }));
    expect((await query({ followUpDue: "true", status: "NEW" })).data.map((r) => r.id)).not.toContain(owned); // it is ASSIGNED
    expect((await query({ followUpDue: "true", status: "ASSIGNED" })).data.map((r) => r.id)).toContain(owned);
  });
});

describe("racing duplicate webhook", () => {
  it("answers both copies with the same lead (one created, one replayed), no 409", async () => {
    const restore = silenceConsole();
    try {
      const input = createLeadSchema.parse({ contactName: "Race", contactPhone: uniquePhone(), orgUnitId: w.units.cityA, sourceCode: w.sourceCode, externalId: "race-1" });
      const results = await Promise.all(Array.from({ length: 4 }, () => createLead(w.stateManager.actor, ctx(), input)));
      expect(new Set(results.map((r) => r.data.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await withTenant(w.tenantId, (tx) => tx.lead.count({ where: { tenantId: w.tenantId, externalId: "race-1" } }))).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("restoring a lead", () => {
  it("moves an owned-status lead that lost its owner to UNASSIGNED, with a history row", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(leadId, w.leadOps.employeeId as string);
    const archive = await call(archiveRoute, "POST", `/api/v1/leads/${leadId}/archive`, { cookie: w.cookies.ceo, params: { id: leadId }, body: {} });
    expect(archive.status).toBe(200);
    expect((await leadRow(w.tenantId, leadId)).status).toBe("ASSIGNED"); // archived keeps its status
    const restored = await call(restoreRoute, "POST", `/api/v1/leads/${leadId}/restore`, { cookie: w.cookies.ceo, params: { id: leadId }, body: {} });
    expect(restored.json.data.status).toBe("UNASSIGNED");
    expect(await activeAssignments(w.tenantId, leadId)).toHaveLength(0);
    const last = (await statusHistory(w.tenantId, leadId)).pop();
    expect(last).toMatchObject({ fromStatus: "ASSIGNED", toStatus: "UNASSIGNED" });
  });
});

describe("releasing with the owner's own open attempt", () => {
  it("is not a conflict: the owner's attempt is closed with the release", async () => {
    const leadId = await intake(w, w.stateManager.actor);
    await assign(leadId, w.leadOps.employeeId as string);
    const attempt = await createInteraction(w.leadOps.actor, contextFor(w.leadOps.actor), leadId, createInteractionSchema.parse({ kind: "CONTACT_ATTEMPT", channel: "PHONE" }));
    await expect(unassignLead(w.stateManager.actor, ctx(), leadId, unassignLeadSchema.parse({ reason: "Owner asked to release" }))).resolves.toMatchObject({ status: "UNASSIGNED" });
    const stored = await withTenant(w.tenantId, (tx) => tx.leadInteraction.findFirstOrThrow({ where: { id: String(attempt.id) } }));
    expect(stored.closedAt).not.toBeNull();
  });
});

describe("concurrent reassignment and contact attempt", () => {
  it("never ends with both a confirmed-free reassignment and an unnoticed open attempt", async () => {
    const restore = silenceConsole();
    try {
      const leadId = await intake(w, w.stateManager.actor);
      await assign(leadId, w.leadOps.employeeId as string);
      const settled = await Promise.allSettled([
        assignLead(w.stateManager.actor, ctx(), leadId, assignLeadSchema.parse({ employeeId: w.leadOps2.employeeId, reason: "Rebalance" })),
        createInteraction(w.leadOps.actor, contextFor(w.leadOps.actor), leadId, createInteractionSchema.parse({ kind: "CONTACT_ATTEMPT", channel: "PHONE" })),
      ]);
      expect(settled[1].status).toBe("fulfilled");
      const [current] = await activeAssignments(w.tenantId, leadId);
      const open = await withTenant(w.tenantId, (tx) => tx.leadInteraction.count({ where: { tenantId: w.tenantId, leadId, kind: "CONTACT_ATTEMPT", closedAt: null } }));
      // Either the reassignment ran first (fine: the attempt was recorded afterwards) or it saw the attempt and refused (409).
      if (settled[0].status === "fulfilled") expect(current.employeeId).toBe(w.leadOps2.employeeId);
      else {
        expect(current.employeeId).toBe(w.leadOps.employeeId);
        expect(open).toBe(1);
      }
    } finally {
      restore();
    }
  });
});
