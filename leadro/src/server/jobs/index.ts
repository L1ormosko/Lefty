// Records
export { createJob, createJobFromLead } from "./create";
export type { JobFromLeadInput, JobFromLeadResult } from "./create";
export { getJob, listJobs, listMyJobs } from "./read";
export { updateJob } from "./update";

// Lifecycle, assignment, scheduling
export { transitionJob } from "./status";
export { assignJob, unassignJob } from "./assignment";
export { rescheduleJob } from "./reschedule";

// Trails and tenant configuration
export { listJobStatusHistory, listJobEvents, listJobAssignments } from "./history";
export { getJobWorkflowSettings, updateJobWorkflowSettings, loadDisabledTransitions } from "./settings";
export type { WorkflowSettingsView } from "./settings";

// Contracts with other modules: the qualification engine, ASSIGNED scope (customers, notifications) and routes
export { getJobEligibilityInputs } from "./eligibility-inputs";
export { assignedEmployeeIdsByJob, jobResourceRef, teamMembers } from "./job-access";
export { registerJobNotificationTarget } from "./notify";

export {
  jobIdParams,
  createJobSchema,
  updateJobSchema,
  transitionJobSchema,
  assignJobSchema,
  unassignJobSchema,
  rescheduleJobSchema,
  listJobsQuerySchema,
  listMyJobsQuerySchema,
  listHistoryQuerySchema,
  updateWorkflowSettingsSchema,
} from "./schemas";
