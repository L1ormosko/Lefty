// Catalogs (skills, certifications / licenses / equipment qualifications / training)
export { listSkills, createSkill, updateSkill, listCertifications, createCertification, updateCertification } from "./catalog";

// Employee skills and credentials, and HR's verification
export { createQualification, updateQualification, getQualification, listQualifications } from "./employee-qualifications";
export { verifyQualification, rejectQualification, revokeQualification } from "./verification";

// Territories, job-category permissions, availability
export { createTerritory, endTerritory, listTerritories } from "./territories";
export { grantJobPermission, endJobPermission, listJobPermissions } from "./job-permissions";
export { createAvailability, deleteAvailability, listAvailability } from "./availability";

// Expiring credentials (notifications, HR list)
export { findExpiringQualifications, listExpiringQualifications, qualificationWarningDays } from "./expiring";
export type { ExpiringQualification } from "./expiring";

// The eligibility engine (dispatch, assignment)
export {
  isEligible,
  evaluateCandidates,
  loadEmployeeFacts,
  requirementsFromInputs,
  requirementsForJobType,
  orgUnitAncestry,
} from "./eligibility";
export type { AdditionalRequirements, EligibilityInputs } from "./eligibility";
export { checkEligibilityAsActor, renderEligibilityFailure } from "./eligibility-check";
export { resolveWorkTimeZone, resolveEmployeeTimeZone } from "./time-zones";

export {
  listCatalogQuerySchema,
  listCertificationsQuerySchema,
  createSkillSchema,
  updateSkillSchema,
  createCertificationSchema,
  updateCertificationSchema,
  createQualificationSchema,
  updateQualificationSchema,
  decisionReasonSchema,
  listQualificationsQuerySchema,
  expiringQualificationsQuerySchema,
  createTerritorySchema,
  listByEmployeeQuerySchema,
  endGrantSchema,
  createJobPermissionSchema,
  createAvailabilitySchema,
  eligibilityCheckSchema,
} from "./schemas";
