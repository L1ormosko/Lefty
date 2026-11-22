/**
 * Types of the eligibility rules (§10.1, §7.3). Pure data: the rules in `evaluate.ts` take these
 * shapes and know nothing about Prisma, so they can be tested without a database and called by any
 * module (the dispatch engine ranks only the employees these rules let through).
 *
 * There is deliberately NO performance data in any of these types (§10.3): eligibility is a legal
 * and safety question (credentials, authorization, territory, availability), never a score.
 */

export type EmployeeStatusName = "ACTIVE" | "ON_LEAVE" | "TERMINATED";
export type QualificationStatusName = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "REVOKED";
export type QualificationKindName = "SKILL" | "CERTIFICATION" | "LICENSE" | "EQUIPMENT" | "TRAINING";

// ───────────────────────── What the job needs ─────────────────────────

export interface SkillRequirement {
  skillId: string;
  /** Minimum proficiency 1-5; null = any level. */
  minLevel: number | null;
  /** Catalog name, only used to make failure reasons readable (a parameter, not eligibility data). */
  name?: string;
}

export interface CertificationRequirement {
  certificationId: string;
  /** The catalog type (CERTIFICATION, LICENSE, EQUIPMENT, TRAINING); reported in failures. */
  kind?: Exclude<QualificationKindName, "SKILL">;
  name?: string;
}

/**
 * Everything the rules need to know about the work. Built from `JobType` + `JobRequirement` rows by
 * the server module (`requirementsFromInputs`, `requirementsForJobType`), or by hand for a "what if".
 */
export interface EligibilityRequirements {
  /** Job type, for the job-category permission. Null = no permission is required. */
  jobTypeId: string | null;
  /** Category of the job type (case-sensitive, tenant-defined). */
  jobCategory: string | null;
  /**
   * The service-area org unit of the job and its ancestors (any order). Null = no territory check.
   * Ancestors let a territory on a state cover jobs in its cities (`includeDescendants`).
   */
  serviceArea: { orgUnitId: string; ancestorOrgUnitIds: string[] } | null;
  skills: SkillRequirement[];
  certifications: CertificationRequirement[];
}

// ───────────────────────── What we know about the employee ─────────────────────────

export interface QualificationFact {
  skillId: string | null;
  certificationId: string | null;
  level: number | null;
  status: QualificationStatusName;
  /** Calendar date (UTC midnight of a `date` column); valid through the END of that local day. Null = never. */
  expiresAt: Date | null;
}

export interface JobPermissionFact {
  jobTypeId: string | null;
  category: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface TerritoryFact {
  orgUnitId: string;
  /** False when the unit is archived: an archived unit no longer covers anything (treated as ended). */
  orgUnitActive: boolean;
  includeDescendants: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface AvailabilityFact {
  kind: "WEEKLY_WINDOW" | "EXCEPTION_AVAILABLE" | "EXCEPTION_UNAVAILABLE";
  /** IANA zone the weekly window is read in. */
  timeZone: string;
  isoDayOfWeek: number | null;
  startMinute: number | null;
  endMinute: number | null;
  validFrom: Date | null;
  validTo: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface EmployeeFacts {
  employeeId: string;
  status: EmployeeStatusName;
  /** Calendar dates (UTC midnight of a `date` column). */
  hireDate: Date | null;
  terminationDate: Date | null;
  qualifications: QualificationFact[];
  jobPermissions: JobPermissionFact[];
  territories: TerritoryFact[];
  availability: AvailabilityFact[];
}

// ───────────────────────── When ─────────────────────────

export interface EligibilityQuery {
  /** When the decision is made (an employee must be ACTIVE now). */
  at: Date;
  /**
   * The span the employee must be able to work: the appointment window or the scheduled slot,
   * `[startsAt, endsAt)`. Null = a decision with no time (availability is then not evaluated and
   * everything else is judged at `at`).
   */
  window: { startsAt: Date; endsAt: Date } | null;
  /** IANA zone in which calendar dates (credential expiry, hire date) are read: the job's own zone. */
  timeZone: string;
}

// ───────────────────────── The verdict ─────────────────────────

/**
 * Why an employee is not eligible. Language-neutral: `code` + `params` only; clients translate with
 * the key `QUALIFICATION.FAILURE.<code>` (the server helper `renderEligibilityFailure` does it).
 */
export type EligibilityFailureCode =
  | "EMPLOYEE_NOT_ACTIVE"
  | "EMPLOYEE_NOT_EMPLOYED"
  | "QUALIFICATION_MISSING"
  | "QUALIFICATION_NOT_VERIFIED"
  | "QUALIFICATION_EXPIRED"
  | "QUALIFICATION_RENEWAL_PENDING"
  | "SKILL_LEVEL_TOO_LOW"
  | "JOB_PERMISSION_MISSING"
  | "OUTSIDE_TERRITORY"
  | "UNAVAILABLE_TIME_OFF"
  | "UNAVAILABLE_OUTSIDE_HOURS";

export const ELIGIBILITY_FAILURE_CODES: readonly EligibilityFailureCode[] = [
  "EMPLOYEE_NOT_ACTIVE",
  "EMPLOYEE_NOT_EMPLOYED",
  "QUALIFICATION_MISSING",
  "QUALIFICATION_NOT_VERIFIED",
  "QUALIFICATION_EXPIRED",
  "QUALIFICATION_RENEWAL_PENDING",
  "SKILL_LEVEL_TOO_LOW",
  "JOB_PERMISSION_MISSING",
  "OUTSIDE_TERRITORY",
  "UNAVAILABLE_TIME_OFF",
  "UNAVAILABLE_OUTSIDE_HOURS",
];

export type FailureParams = Record<string, string | number | null>;

export interface EligibilityFailure {
  code: EligibilityFailureCode;
  params: FailureParams;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Every hard rule that failed (not just the first), in a stable order. Empty when eligible. */
  failures: EligibilityFailure[];
  /** Which optional rules were evaluated, so "eligible" is never read as "availability was confirmed". */
  checked: { availability: boolean; territory: boolean; jobPermission: boolean };
}
