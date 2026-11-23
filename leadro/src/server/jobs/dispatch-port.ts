/**
 * What the dispatch module may use from jobs, in one place. Dispatch accepts a recommendation by running the jobs module's own
 * assignment (`assignJobInTx`: hard eligibility, override rights, trails, notifications) inside ITS transaction, after taking
 * the job lock (`lockJob`) so the decision, the staleness check and the assignment are one atomic step.
 */
export { assignJobInTx } from "./assignment";
export type { AssignmentProvenance } from "./assignment";
export { lockJob } from "./job-access";
