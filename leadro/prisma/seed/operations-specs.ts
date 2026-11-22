import type { LeadSourceType, QualificationKind, QualificationStatus } from "@prisma/client";

/**
 * Development seed data for the operational core (Phase 2): the catalogs every field-service company
 * starts with, and a few technicians with realistic, deliberately uneven qualifications so the
 * eligibility engine and the dispatch board have something to show (including an expiring and an
 * expired license). Everything here is fictional.
 */

export interface SkillSpec {
  code: string;
  name: string;
  category: string;
}

export interface CertificationSpec {
  code: string;
  name: string;
  type: Exclude<QualificationKind, "SKILL">;
  issuingAuthority?: string;
  validityMonths?: number;
  requiresNumber?: boolean;
}

export interface JobTypeSpec {
  code: string;
  name: string;
  category: string;
  defaultDurationMinutes: number;
  requiresReview?: boolean;
  requiredEquipment: string[];
  /** `[skill code, minimum level]` */
  skills: Array<[string, number]>;
  certifications: string[];
}

export interface LeadSourceSpec {
  code: string;
  name: string;
  type: LeadSourceType;
}

export interface QualificationSpec {
  /** Skill code or certification code. */
  code: string;
  level?: number;
  number?: string;
  status: QualificationStatus;
  /** Days from today; negative = in the past. `null` = does not expire / not applicable. */
  issuedDaysAgo?: number;
  expiresInDays?: number | null;
}

export interface TechnicianProfile {
  key: string;
  title: string;
  qualifications: QualificationSpec[];
  /** Job categories (JobType.category) this technician may take (spec 10.1 job-category permissions). */
  jobCategories: string[];
  /** ISO weekdays (1 = Monday) worked, 08:00-17:00 unless `hours` is given. */
  weekdays: number[];
  /** `[startMinute, endMinute]` after local midnight. */
  hours?: [number, number];
  /** Covers the whole region of the team instead of only the city. */
  coversRegion?: boolean;
  /** Time off starting this many days from today, lasting `days`. */
  timeOff?: { startsInDays: number; days: number; note: string };
}

export const SKILLS: SkillSpec[] = [
  { code: "hvac-install", name: "HVAC installation", category: "HVAC" },
  { code: "hvac-repair", name: "HVAC repair and diagnostics", category: "HVAC" },
  { code: "electrical-wiring", name: "Electrical wiring and panels", category: "Electrical" },
  { code: "plumbing-repair", name: "Plumbing repair", category: "Plumbing" },
  { code: "appliance-repair", name: "Appliance repair", category: "Appliances" },
  { code: "smart-thermostat", name: "Smart thermostat setup", category: "HVAC" },
];

export const CERTIFICATIONS: CertificationSpec[] = [
  { code: "epa-608", name: "EPA Section 608 refrigerant handling", type: "CERTIFICATION", issuingAuthority: "US EPA" },
  { code: "osha-10", name: "OSHA 10-hour safety card", type: "CERTIFICATION", issuingAuthority: "OSHA Outreach" },
  { code: "tx-hvac-license", name: "Texas HVAC contractor license", type: "LICENSE", issuingAuthority: "TDLR", validityMonths: 12, requiresNumber: true },
  { code: "tx-electrician-license", name: "Texas journeyman electrician license", type: "LICENSE", issuingAuthority: "TDLR", validityMonths: 12, requiresNumber: true },
  { code: "aerial-lift", name: "Aerial lift operator authorization", type: "EQUIPMENT", validityMonths: 36 },
  { code: "recovery-machine", name: "Refrigerant recovery machine authorization", type: "EQUIPMENT", validityMonths: 24 },
];

export const JOB_TYPES: JobTypeSpec[] = [
  {
    code: "ac-install",
    name: "AC system installation",
    category: "installation",
    defaultDurationMinutes: 300,
    requiredEquipment: ["Recovery machine", "Ladder", "Vacuum pump"],
    skills: [["hvac-install", 3]],
    certifications: ["epa-608", "tx-hvac-license", "recovery-machine"],
  },
  {
    code: "ac-repair",
    name: "AC repair and diagnostics",
    category: "repair",
    defaultDurationMinutes: 90,
    requiredEquipment: ["Gauge set", "Multimeter"],
    skills: [["hvac-repair", 2]],
    certifications: ["epa-608"],
  },
  {
    code: "panel-upgrade",
    name: "Electrical panel upgrade",
    category: "installation",
    defaultDurationMinutes: 360,
    requiredEquipment: ["Insulated tools", "Panel kit"],
    skills: [["electrical-wiring", 4]],
    certifications: ["tx-electrician-license", "osha-10"],
  },
  {
    code: "leak-repair",
    name: "Plumbing leak repair",
    category: "repair",
    defaultDurationMinutes: 90,
    requiredEquipment: ["Pipe wrench set", "Leak detector"],
    skills: [["plumbing-repair", 2]],
    certifications: [],
  },
  {
    code: "appliance-service",
    name: "Appliance service call",
    category: "repair",
    defaultDurationMinutes: 60,
    requiredEquipment: ["Appliance tool kit"],
    skills: [["appliance-repair", 2]],
    certifications: [],
  },
  {
    code: "seasonal-inspection",
    name: "Seasonal system inspection",
    category: "inspection",
    defaultDurationMinutes: 60,
    requiresReview: true,
    requiredEquipment: ["Inspection checklist tablet"],
    skills: [["hvac-repair", 1]],
    certifications: [],
  },
];

export const LEAD_SOURCES: LeadSourceSpec[] = [
  { code: "manual", name: "Manual entry", type: "MANUAL" },
  { code: "phone", name: "Inbound phone call", type: "PHONE" },
  { code: "website", name: "Website form", type: "WEBSITE" },
  { code: "search-ads", name: "Search advertising campaign", type: "MARKETING_CAMPAIGN" },
  { code: "partner-crm", name: "Partner CRM referral", type: "EXTERNAL_CRM" },
  { code: "lead-api", name: "Lead provider API", type: "API" },
];

/**
 * Technician profiles. The Technician with a login always gets the first profile; each team gets
 * the others as employees WITHOUT a login (no dev password to manage, and the one-user-per-template
 * seed contract stays intact).
 */
export const TECHNICIAN_PROFILES: TechnicianProfile[] = [
  {
    key: "senior-hvac",
    jobCategories: ["installation", "repair", "inspection"],
    title: "Senior HVAC Technician",
    weekdays: [1, 2, 3, 4, 5],
    coversRegion: true,
    qualifications: [
      { code: "hvac-install", level: 5, status: "VERIFIED" },
      { code: "hvac-repair", level: 4, status: "VERIFIED" },
      { code: "smart-thermostat", level: 4, status: "VERIFIED" },
      { code: "epa-608", number: "608-UNIV-48213", status: "VERIFIED", issuedDaysAgo: 900, expiresInDays: null },
      { code: "tx-hvac-license", number: "TACLA-27744E", status: "VERIFIED", issuedDaysAgo: 200, expiresInDays: 165 },
      { code: "recovery-machine", status: "VERIFIED", issuedDaysAgo: 400, expiresInDays: 330 },
    ],
  },
  {
    key: "electrician",
    jobCategories: ["installation", "repair"],
    title: "Journeyman Electrician",
    weekdays: [1, 2, 3, 4, 5],
    qualifications: [
      { code: "electrical-wiring", level: 4, status: "VERIFIED" },
      { code: "plumbing-repair", level: 2, status: "VERIFIED" },
      { code: "tx-electrician-license", number: "JE-310982", status: "VERIFIED", issuedDaysAgo: 340, expiresInDays: 25 }, // expires soon
      { code: "osha-10", status: "VERIFIED", issuedDaysAgo: 700, expiresInDays: null },
    ],
  },
  {
    key: "junior-generalist",
    jobCategories: ["repair", "inspection"],
    title: "Service Technician (junior)",
    weekdays: [1, 2, 3],
    hours: [600, 1080],
    qualifications: [
      { code: "hvac-repair", level: 2, status: "VERIFIED" },
      { code: "appliance-repair", level: 3, status: "VERIFIED" },
      { code: "epa-608", number: "608-TYPE1-90012", status: "PENDING_VERIFICATION", issuedDaysAgo: 20, expiresInDays: null },
      { code: "osha-10", status: "VERIFIED", issuedDaysAgo: 120, expiresInDays: null },
    ],
  },
  {
    key: "plumber-expired-license",
    jobCategories: ["repair"],
    title: "Plumbing and Electrical Technician",
    weekdays: [2, 3, 4, 5, 6],
    timeOff: { startsInDays: 7, days: 5, note: "Vacation" },
    qualifications: [
      { code: "plumbing-repair", level: 5, status: "VERIFIED" },
      { code: "electrical-wiring", level: 5, status: "VERIFIED" },
      { code: "tx-electrician-license", number: "JE-204455", status: "VERIFIED", issuedDaysAgo: 400, expiresInDays: -35 }, // expired
    ],
  },
];

/** Branch coordinates (fictional street addresses near each city centre), the origin of straight-line distance estimates. */
export const BRANCH_COORDINATES: Record<string, [number, number]> = {
  "Dallas Central": [32.7791, -96.8003],
  "Fort Worth Stockyards": [32.7896, -97.3478],
  "Houston Downtown": [29.7604, -95.3698],
  "Miami Brickell": [25.7617, -80.1918],
  "Los Angeles Westside": [34.0522, -118.4437],
  "San Diego Gaslamp": [32.7113, -117.1593],
  "Austin Downtown": [30.2672, -97.7431],
  "Orlando Downtown": [28.5383, -81.3792],
  "San Jose Downtown": [37.3382, -121.8863],
};
