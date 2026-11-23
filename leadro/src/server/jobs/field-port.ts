/**
 * What field-execution modules (outcomes now; arrival, completion and sync later) may use from jobs:
 * the locked read of a job and the ONE function that changes its status. They authorize their own
 * action (e.g. `job_outcomes.create`) and then ask the jobs lifecycle to apply the consequence, so no
 * module can skip a transition rule, the closing guard or the visit-number bookkeeping.
 */
export { changeJobStatus, loadJobForChange } from "./status";
export type { JobForChange, StatusChangeOptions, StatusChangeResult } from "./status";
export { recordJobEvent } from "./events";
