import { registerLeadNotifications } from "./notifications";

// Intake, records, lifecycle
export { createLead } from "./intake";
export type { CreateLeadResult } from "./intake";
export { getLead, listLeads, updateLead, archiveLead, restoreLead } from "./leads";
export { changeLeadStatus, listLeadStatusHistory } from "./lifecycle";

// Ownership (§25.1 conflict rules), contact attempts and follow-ups
export { assignLead, unassignLead } from "./assignment";
export { createInteraction, closeInteraction, listInteractions, findOpenContactAttempts } from "./interactions";

// Customer link, conversion to a job
export { linkLeadCustomer } from "./customer-link";
export { convertLead } from "./conversion";
export type { ConvertLeadResult } from "./conversion";
export { createJobFromLead } from "./job-conversion-port";
export type { CreateJobFromLeadInput, CreatedJob } from "./job-conversion-port";

// Duplicates (§6.4) and sources (§6.2)
export { flagLeadDuplicates, revealableLeadDuplicates, listLeadDuplicateFlags, resolveLeadDuplicateFlag, RECENT_LEAD_WINDOW_DAYS } from "./duplicates";
export type { OpenLeadDuplicate } from "./duplicates";
export { listLeadSources, createLeadSource, updateLeadSource } from "./sources";

// Scope helpers (route resolvers, notifications, tests)
export { leadResourceRef, leadRowAttributes, resolveLeadListAccess, visibleLeadIds, DISPATCH_RELATED_STATUSES } from "./lead-access";
export { registerLeadNotifications } from "./notifications";

export {
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuerySchema,
  changeLeadStatusSchema,
  assignLeadSchema,
  unassignLeadSchema,
  createInteractionSchema,
  closeInteractionSchema,
  listInteractionsQuerySchema,
  linkCustomerSchema,
  convertLeadSchema,
  archiveLeadSchema,
  listLeadDuplicatesQuerySchema,
  resolveLeadDuplicateSchema,
  createLeadSourceSchema,
  updateLeadSourceSchema,
  leadIdParams,
  leadInteractionParams,
  leadDuplicateFlagParams,
  leadSourceParams,
} from "./schemas";

// The notifications engine redacts a lead notification unless this resolver is registered; loading the module registers it.
registerLeadNotifications();
