import { randomUUID } from "node:crypto";
import { withTenant } from "@/server/db";
import { createPerson, grantTemplate } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { sessionCookie } from "../org/org-helpers";

/**
 * The finance tests' world: the jobs world (State S > City A > Team A1, City B; one person per template) plus a COO
 * session. Jobs are created through the API (City A by default, City B with `inCityB`); outcomes are stored straight in
 * the database (finance does not care how the visit got there, only what the technician reported).
 */
export interface FinanceWorld extends JobsWorld {
  cooCookie: string;
}

export async function buildFinanceWorld(label: string): Promise<FinanceWorld> {
  const w = await buildJobsWorld(label);
  const coo = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, coo, w.roles.COO, [{ type: "TENANT" }]);
  return { ...w, cooCookie: await sessionCookie(coo, w.tenantId) };
}

export async function makeJob(w: FinanceWorld, options: { inCityB?: boolean } = {}): Promise<{ id: string; customerId: string }> {
  const body = options.inCityB ? { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId } : {};
  const job = await createJobViaApi(w, body, w.cookie.ceo);
  return { id: job.id as string, customerId: job.customerId as string };
}

/** A SOLD outcome for the job's current visit with the given money, as a technician would have reported it. */
export async function storeSoldOutcome(
  w: FinanceWorld,
  jobId: string,
  money: { charged?: bigint; collected?: bigint; method?: "CASH" | "CARD" | "CHECK" } = {},
): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const job = await tx.job.findFirstOrThrow({ where: { id: jobId }, select: { currentVisitNumber: true } });
    const outcome = await tx.jobOutcome.create({
      data: {
        tenantId: w.tenantId,
        jobId,
        visitNumber: job.currentVisitNumber,
        outcome: "SOLD",
        employeeId: w.techA1.employeeId,
        chargedAmountMinor: money.charged ?? null,
        collectedAmountMinor: money.collected ?? null,
        paymentMethod: money.collected ? (money.method ?? "CASH") : null,
        paymentStatus: money.collected ? "PARTIAL" : "PENDING",
        occurredAt: new Date(Date.now() - 3_600_000),
      },
    });
    return outcome.id;
  });
}

export const idempotencyHeader = (key: string = randomUUID()) => ({ "idempotency-key": key });

/** Every ledger entry of a job, oldest first (RLS-scoped). */
export const ledgerOf = (w: FinanceWorld, jobId: string) =>
  withTenant(w.tenantId, (tx) => tx.ledgerEntry.findMany({ where: { jobId }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] }));
