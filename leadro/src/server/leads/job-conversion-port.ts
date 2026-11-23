/**
 * The seam between leads and jobs (§6.3 -> §7.1). Lead conversion creates the job through the jobs module's
 * `createJobFromLead(tx, actor, input, ctx?)` inside the SAME transaction as the lead change, so a lead is never
 * CONVERTED without its job. The jobs module owns everything about the job; it is idempotent per lead (a repeat
 * returns the existing job with `created: false`). Tests mock this file to inject failures.
 */
export { createJobFromLead } from "@/server/jobs";
export type { JobFromLeadInput as CreateJobFromLeadInput, JobFromLeadResult as CreatedJob } from "@/server/jobs";
