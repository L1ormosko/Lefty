import { randomUUID } from "node:crypto";
import { withTenant } from "@/server/db";
import { activateRule, createRule, createRuleSchema, handleOutcomeRecorded, submitRule } from "@/server/recovery";
import { buildWorld, createPerson, grantTemplate, type Person, type World } from "../authz/fixtures";
import { makeCustomer } from "../customers/fixtures";
import { makeJob } from "../customers/fixtures";
import { contextFor } from "../org/org-helpers";

/**
 * A tenant for the recovery tests: the standard world plus a Lead Operations manager over City A, a customer with a job in
 * City A (its address has coordinates) and a lost reason. `makeOutcome` stores a NOT_SOLD outcome straight in the database and
 * (by default) runs the engine handler on it, exactly as the recording transaction does.
 */
export interface RecoveryWorld extends World {
  leadOps: Person;
  leadOpsB: Person;
  customerId: string;
  reasonId: string;
  unrecoverableReasonId: string;
}

export const SITE = { latitude: 40.0, longitude: -75.0 };

export async function buildRecoveryWorld(label: string): Promise<RecoveryWorld> {
  const w = await buildWorld(label);
  const leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  const leadOpsB = await createPerson(w.tenantId, "lead-ops-b", { orgUnitId: w.units.cityB, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, leadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  await grantTemplate(w.tenantId, leadOpsB, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);
  const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
  const [reasonId, unrecoverableReasonId] = await withTenant(w.tenantId, async (tx) => {
    const price = await tx.lostReason.create({ data: { tenantId: w.tenantId, code: "price", name: "Price too high", recoverable: true } });
    const scope = await tx.lostReason.create({ data: { tenantId: w.tenantId, code: "outside", name: "Outside scope", recoverable: false } });
    return [price.id, scope.id];
  });
  return { ...w, leadOps, leadOpsB, customerId: customer.id, reasonId, unrecoverableReasonId };
}

/** A job in City A for the world's customer, its address placed at `SITE`. */
export async function makeSiteJob(w: RecoveryWorld, orgUnitId = w.units.cityA, customerId = w.customerId): Promise<string> {
  const jobId = await makeJob(w.tenantId, customerId, orgUnitId);
  await withTenant(w.tenantId, async (tx) => {
    const job = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId: w.tenantId }, select: { serviceAddressId: true } });
    await tx.customerAddress.update({ where: { id: job.serviceAddressId }, data: { latitude: SITE.latitude, longitude: SITE.longitude } });
  });
  return jobId;
}

export interface MadeOutcome {
  jobId: string;
  outcomeId: string;
}

/** Stores a NOT_SOLD outcome for `jobId` (visit 1 unless given) and runs the engine on it. */
export async function makeOutcome(
  w: RecoveryWorld,
  jobId: string,
  options: { employeeId?: string; lostReasonId?: string | null; quotedAmountMinor?: number | null; outcome?: "NOT_SOLD" | "WORK_NOT_POSSIBLE"; visitNumber?: number; run?: boolean; customerRequestedFollowUp?: boolean } = {},
): Promise<MadeOutcome> {
  const outcomeId = randomUUID();
  const lostReasonId = options.lostReasonId === undefined ? w.reasonId : options.lostReasonId;
  const outcome = options.outcome ?? "NOT_SOLD";
  await withTenant(w.tenantId, async (tx) => {
    await tx.jobOutcome.create({
      data: {
        id: outcomeId,
        tenantId: w.tenantId,
        jobId,
        visitNumber: options.visitNumber ?? 1,
        employeeId: options.employeeId ?? w.techA1.employeeId,
        outcome,
        lostReasonId,
        quotedAmountMinor: options.quotedAmountMinor === undefined ? 120_000 : options.quotedAmountMinor,
        customerRequestedFollowUp: options.customerRequestedFollowUp ?? false,
      },
    });
    if (options.run !== false) {
      await handleOutcomeRecorded(tx, {
        tenantId: w.tenantId,
        jobId,
        outcomeId,
        visitNumber: options.visitNumber ?? 1,
        outcome,
        lostReasonId,
        lostReasonRecoverable: lostReasonId === w.unrecoverableReasonId ? false : lostReasonId ? true : null,
        notConverted: true,
        customerRequestedFollowUp: options.customerRequestedFollowUp ?? false,
        retroactive: false,
        jobStatus: "COMPLETED",
      });
    }
  });
  return { jobId, outcomeId };
}

/**
 * Creates and activates a rule through the services (the Owner authors and, for a high-impact rule, the Lead Ops manager
 * cannot approve, so the test rule is authored by Lead Ops and approved by the Owner). Returns the rule id.
 */
export async function makeActiveRule(w: RecoveryWorld, fields: Record<string, unknown>): Promise<string> {
  const input = createRuleSchema.parse({ name: "Test rule", ruleKey: `rule-${randomUUID().slice(0, 8)}`, conditions: {}, actions: [{ type: "create_case" }], orgUnitId: w.units.cityA, ...fields });
  const created = await createRule(w.leadOps.actor, contextFor(w.leadOps.actor), input);
  const id = String(created.id);
  if (created.highImpact) {
    await submitRule(w.leadOps.actor, contextFor(w.leadOps.actor), id);
    await activateRule(w.ceo.actor, contextFor(w.ceo.actor), id);
  } else {
    await activateRule(w.leadOps.actor, contextFor(w.leadOps.actor), id);
  }
  return id;
}

/** Stores a location event for an employee straight in the database (the engine only reads presence). */
export async function storeLocation(
  w: RecoveryWorld,
  employeeId: string,
  options: { latitude: number; longitude: number; accuracyM?: number; ageMinutes?: number },
): Promise<string> {
  const when = new Date(Date.now() - (options.ageMinutes ?? 1) * 60_000);
  return withTenant(w.tenantId, async (tx) => {
    const event = await tx.locationEvent.create({
      data: {
        tenantId: w.tenantId,
        employeeId,
        kind: "VERIFICATION",
        source: "DEVICE_GPS",
        latitude: options.latitude,
        longitude: options.longitude,
        accuracyM: options.accuracyM ?? 20,
        deviceTime: when,
        serverTime: when,
        orgUnitId: w.units.cityA,
      },
      select: { id: true },
    });
    return event.id;
  });
}
