import { createFollowUp, createFollowUpSchema } from "@/server/follow-ups";
import { withTenant } from "@/server/db";
import { buildWorld, type Person, type World } from "../authz/fixtures";
import { assignJob, assignLead, makeCustomer, makeJob, makeLead } from "../customers/fixtures";
import { contextFor, sessionCookie } from "../org/org-helpers";

/**
 * A tenant for the follow-up tests: the standard world (City A with Team A1 under State S; City B beside it) plus one
 * customer, lead and job per city. techA1 works the City A lead and job; nobody works the City B ones.
 */
export interface FollowUpWorld extends World {
  customerA: string;
  customerB: string;
  leadA: string;
  leadB: string;
  jobA: string;
  jobB: string;
  cookies: Record<"ceo" | "stateManager" | "cityManagerA" | "cityManagerB" | "dispatcher" | "techA1" | "techA1Other" | "techB", string>;
}

export async function buildFollowUpWorld(label: string): Promise<FollowUpWorld> {
  const w = await buildWorld(label);
  const customerA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
  const customerB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
  const leadA = await makeLead(w.tenantId, customerA.id, { orgUnitId: w.units.cityA });
  const leadB = await makeLead(w.tenantId, customerB.id, { orgUnitId: w.units.cityB });
  const jobA = await makeJob(w.tenantId, customerA.id, w.units.cityA);
  const jobB = await makeJob(w.tenantId, customerB.id, w.units.cityB);
  await assignLead(w.tenantId, leadA, w.techA1.employeeId as string);
  await assignJob(w.tenantId, jobA, { employeeId: w.techA1.employeeId as string });
  const cookies = {
    ceo: await sessionCookie(w.ceo, w.tenantId),
    stateManager: await sessionCookie(w.stateManager, w.tenantId),
    cityManagerA: await sessionCookie(w.cityManagerA, w.tenantId),
    cityManagerB: await sessionCookie(w.cityManagerB, w.tenantId),
    dispatcher: await sessionCookie(w.dispatcher, w.tenantId),
    techA1: await sessionCookie(w.techA1, w.tenantId),
    techA1Other: await sessionCookie(w.techA1Other, w.tenantId),
    techB: await sessionCookie(w.techB, w.tenantId),
  };
  return { ...w, customerA: customerA.id, customerB: customerB.id, leadA, leadB, jobA, jobB, cookies };
}

export const hoursFromNow = (hours: number): Date => new Date(Date.now() + hours * 3_600_000);

/** Creates a follow-up through the service as `person`; returns its id. */
export async function makeFollowUp(
  person: Person,
  fields: { targetType: "LEAD" | "CUSTOMER" | "JOB" | "RECOVERY_CASE"; targetId: string } & Record<string, unknown>,
): Promise<string> {
  const input = createFollowUpSchema.parse({ title: "Call the customer back", dueAt: hoursFromNow(24), ...fields });
  const view = await createFollowUp(person.actor, contextFor(person.actor), input);
  return String(view.id);
}

export async function followUpRow(tenantId: string, followUpId: string) {
  return withTenant(tenantId, (tx) => tx.followUpTask.findFirstOrThrow({ where: { id: followUpId, tenantId } }));
}

/** Set-up shortcut: moves a task's due time (and clears the sweep stamps) directly in the database. */
export async function setDueAt(tenantId: string, followUpId: string, dueAt: Date): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.followUpTask.update({ where: { id: followUpId }, data: { dueAt, dueSoonNotifiedAt: null, overdueNotifiedAt: null } }),
  );
}
