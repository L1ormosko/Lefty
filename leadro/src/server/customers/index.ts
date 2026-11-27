export {
  createCustomer,
  updateCustomer,
  archiveCustomer,
  restoreCustomer,
  getCustomer,
  listCustomers,
} from "./customers";
export { listAddresses, addAddress, updateAddress, archiveAddress } from "./addresses";
export { listNotes, addNote } from "./notes";
export { listEmployeePreferences, setEmployeePreferences } from "./preferences";
export { getCustomerHistory } from "./history";
export type { CustomerHistory, CustomerHistoryEntry } from "./history";

// Duplicate detection (§6.4): the matchers, the shared candidate search (also used by leads) and the review queue.
export {
  DEFAULT_DUPLICATE_MATCHERS,
  parseDuplicateMatchers,
  loadDuplicateMatchers,
  findDuplicateCustomerCandidates,
  flagCustomerDuplicates,
  customerPairKey,
} from "./duplicate-detection";
export type { DuplicateMatchers, DuplicateMatchKeys, DuplicateCandidate, OpenDuplicate } from "./duplicate-detection";
export { getDuplicateMatchers, setDuplicateMatchers } from "./duplicate-matchers";
export type { DuplicateMatcherSettings } from "./duplicate-matchers";
export { listDuplicateFlags, resolveDuplicateFlag } from "./duplicate-flags";

// ASSIGNED scope contract shared with the leads and jobs modules (see README "Shared ASSIGNED-scope helper").
export {
  leadAssignedToWhere,
  jobAssignedToWhere,
  leadScopeColumns,
  jobScopeColumns,
  customerAssignedToWhere,
  assignedEmployeeIdsByCustomer,
  teamMembers,
} from "./assignment-access";
export { customerResourceRef, customerScopeColumns, resolveCustomerListAccess, visibleCustomerIds, revealableDuplicates, assertCustomerActive } from "./customer-access";
export type { CustomerListAccess } from "./customer-access";

export {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
  archiveCustomerSchema,
  createAddressSchema,
  updateAddressSchema,
  createNoteSchema,
  listNotesQuerySchema,
  historyQuerySchema,
  setEmployeePreferencesSchema,
  listDuplicatesQuerySchema,
  resolveDuplicateSchema,
  duplicateMatchersSchema,
  customerIdParams,
  customerAddressParams,
  duplicateFlagParams,
} from "./schemas";
