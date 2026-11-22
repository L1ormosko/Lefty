import { withTenant } from "@/server/db";
import { createLead, createLeadSchema, createLeadSource, createLeadSourceSchema } from "@/server/leads";
import { buildWorld, createPerson, grantTemplate, type Person, type World } from "../authz/fixtures";
import { contextFor, sessionCookie } from "../org/org-helpers";

/** A tenant for the leads tests: the standard world plus two Lead Operations employees and a lead source. */
export interface LeadWorld extends World {
  leadOps: Person;
  leadOps2: Person;
  sourceId: string;
  sourceCode: string;
  cookies: Record<"ceo" | "stateManager" | "cityManagerA" | "cityManagerB" | "dispatcher" | "leadOps" | "techA1" | "techB", string>;
}

export async function buildLeadWorld(label: string): Promise<LeadWorld> {
  const w = await buildWorld(label);
  const leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  const leadOps2 = await createPerson(w.tenantId, "lead-ops2", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  for (const person of [leadOps, leadOps2]) {
    await grantTemplate(w.tenantId, person, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
  }
  const sourceCode = "web-form";
  const source = await createLeadSource(w.ceo.actor, contextFor(w.ceo.actor), createLeadSourceSchema.parse({ code: sourceCode, name: "Web form", type: "WEBSITE" }));
  const cookies = {
    ceo: await sessionCookie(w.ceo, w.tenantId),
    stateManager: await sessionCookie(w.stateManager, w.tenantId),
    cityManagerA: await sessionCookie(w.cityManagerA, w.tenantId),
    cityManagerB: await sessionCookie(w.cityManagerB, w.tenantId),
    dispatcher: await sessionCookie(w.dispatcher, w.tenantId),
    leadOps: await sessionCookie(leadOps, w.tenantId),
    techA1: await sessionCookie(w.techA1, w.tenantId),
    techB: await sessionCookie(w.techB, w.tenantId),
  };
  return { ...w, leadOps, leadOps2, sourceId: String(source.id), sourceCode, cookies };
}

let counter = 0;
/** A unique, valid US phone number (+1 555 01xx-style numbers could repeat across tests; this never does within a process). */
export function uniquePhone(): string {
  counter += 1;
  return `+1202555${String(1000 + counter).padStart(4, "0")}`;
}

/** Creates a lead through the service (as `actor`) with sensible defaults; returns its id. */
export async function intake(w: LeadWorld, actor: Person["actor"], fields: Record<string, unknown> = {}): Promise<string> {
  const input = createLeadSchema.parse({ contactName: "Test Caller", contactPhone: uniquePhone(), orgUnitId: w.units.cityA, ...fields });
  const result = await createLead(actor, contextFor(actor), input);
  return String(result.data.id);
}

/** Moves a lead's status directly in the database (set-up shortcut for states the service reaches through several steps). */
export async function forceStatus(tenantId: string, leadId: string, status: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.lead.update({ where: { id: leadId }, data: { status: status as never } }));
}

export async function activeAssignments(tenantId: string, leadId: string) {
  return withTenant(tenantId, (tx) => tx.leadAssignment.findMany({ where: { tenantId, leadId, state: "ACTIVE" } }));
}

export async function statusHistory(tenantId: string, leadId: string) {
  return withTenant(tenantId, (tx) => tx.leadStatusHistory.findMany({ where: { tenantId, leadId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }));
}

export async function leadRow(tenantId: string, leadId: string) {
  return withTenant(tenantId, (tx) => tx.lead.findFirstOrThrow({ where: { id: leadId, tenantId } }));
}
