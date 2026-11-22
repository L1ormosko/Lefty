import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * The seam between leads and jobs (§6.3 -> §7.1). Lead conversion creates the job through
 * `createJobFromLead`, which the jobs module exports from `@/server/jobs` with exactly this signature; it runs in the
 * SAME transaction as the lead change, so a lead is never CONVERTED without its job and a job never exists without
 * the lead turning CONVERTED. The jobs module owns everything about the job (number, requirements, status history,
 * its own permission check); one job per lead is enforced by `Job_leadId_tenantId_key`.
 *
 * WIRING: the jobs module was built in parallel with this one, so until it is merged this file holds a stub that
 * fails loudly. When `@/server/jobs` exists, replace the stub body with
 *
 *     export { createJobFromLead } from "@/server/jobs";
 *
 * (keep the two types below only if the jobs module does not export compatible ones). Nothing else in the leads
 * module changes. Tests mock this file (`tests/leads/conversion.test.ts`).
 */

export interface CreateJobFromLeadInput {
  leadId: string;
  customerId: string;
  /** One of the customer's addresses (the job's `serviceAddressId`). */
  serviceAddressId: string;
  jobTypeId: string;
  description?: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  appointmentWindow?: { start: Date; end: Date };
}

export interface CreatedJob {
  id: string;
  number: number;
}

export async function createJobFromLead(_tx: TenantTx, _actor: Actor, _input: CreateJobFromLeadInput): Promise<CreatedJob> {
  throw new Error("createJobFromLead is not wired yet: connect src/server/leads/job-conversion-port.ts to @/server/jobs.");
}
