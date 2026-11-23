/**
 * Permission catalog: the fixed set of (module, action) pairs the platform checks (spec 4.3).
 * Seeded into the global `Permission` table. Roles are tenant-configurable bundles of these;
 * role names never grant access. Keep docs/PERMISSIONS.md in sync with this file.
 */
export const PERMISSION_ACTIONS = [
  "VIEW",
  "CREATE",
  "EDIT",
  "ARCHIVE",
  "ASSIGN",
  "APPROVE",
  "REJECT",
  "EXPORT",
  "MANAGE",
  "CONFIGURE",
] as const;
export type PermissionActionName = (typeof PERMISSION_ACTIONS)[number];

export interface PermissionDef {
  module: string;
  action: PermissionActionName;
  description: string;
  sensitive?: boolean;
}

const mod = (
  module: string,
  label: string,
  actions: PermissionActionName[],
  sensitiveActions: PermissionActionName[] = [],
): PermissionDef[] =>
  actions.map((action) => ({
    module,
    action,
    description: `${action.toLowerCase()} ${label}`,
    sensitive: sensitiveActions.includes(action),
  }));

export const PERMISSION_CATALOG: PermissionDef[] = [
  ...mod("company_settings", "company settings", ["VIEW", "EDIT", "CONFIGURE"], ["CONFIGURE"]),
  ...mod("organization", "organization structure", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "MANAGE"]),
  ...mod("users", "user accounts", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "MANAGE"], ["MANAGE"]),
  ...mod("employees", "employee records", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "EXPORT"], ["EXPORT"]),
  ...mod("permissions", "roles and access", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "APPROVE", "MANAGE"], ["ASSIGN", "MANAGE"]),
  ...mod("audit", "audit log", ["VIEW", "EXPORT"], ["EXPORT"]),
  ...mod("localization", "translations", ["VIEW", "EDIT", "CONFIGURE"]),
  // MANAGE = module settings that are not "configure": duplicate matchers (customers), lead sources (leads).
  ...mod("customers", "customers", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "EXPORT", "MANAGE"]),
  ...mod("leads", "leads", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "EXPORT", "MANAGE"]),
  ...mod("dispatch", "dispatch", ["VIEW", "CREATE", "EDIT", "ASSIGN", "MANAGE"]),
  ...mod("jobs", "jobs", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "APPROVE", "REJECT", "EXPORT"]),
  // Skills, certifications, licenses, equipment qualifications, territories, availability (spec 10.1).
  ...mod("qualifications", "employee qualifications", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "APPROVE", "MANAGE"]),
  // Own notifications only: services always filter on the caller, so the grant's scope is irrelevant.
  ...mod("notifications", "own notifications", ["VIEW", "EDIT"]),
  // Job type catalog + job workflow settings (spec 7.1-7.2). CONFIGURE makes a role require MFA like every *.configure.
  ...mod("job_types", "job types and job workflow", ["VIEW", "CONFIGURE"]),
  ...mod("compensation", "compensation", ["VIEW", "CREATE", "EDIT", "APPROVE", "REJECT", "EXPORT", "CONFIGURE"], ["VIEW", "APPROVE", "CONFIGURE"]),
  ...mod("financial_reports", "financial reports", ["VIEW", "EXPORT"], ["VIEW", "EXPORT"]),
  ...mod("performance", "performance data", ["VIEW", "EXPORT"]),

  // ── Phase 3: field operations and recovery ──
  // Shifts (spec 8.1): CREATE starts a shift, EDIT ends/corrects one (technicians: own shift, OWN scope),
  // APPROVE accepts a shift started or ended under an exception (GPS off, offline).
  ...mod("shifts", "work shifts", ["VIEW", "CREATE", "EDIT", "APPROVE"]),
  // Location history (spec 17, 22.2) is sensitive: VIEW reads events and verifications WITHOUT coordinates
  // (the opt-in `location.coordinate_fields` set adds them); CREATE records an event (a technician's own);
  // APPROVE is a manager verifying or overriding an arrival / location exception.
  ...mod("location", "location events and arrival verification", ["VIEW", "CREATE", "APPROVE"], ["VIEW", "APPROVE"]),
  // Outcome reporting (spec 9.1, 9.2): CREATE reports a visit outcome, EDIT corrects it, CONFIGURE = lost reasons.
  ...mod("job_outcomes", "job outcomes and lost reasons", ["VIEW", "CREATE", "EDIT", "CONFIGURE"]),
  // Completion form definitions per job type / category (spec 8.6); VIEW is what a technician needs to fill one in.
  ...mod("completion_forms", "job completion forms", ["VIEW", "CONFIGURE"]),
  // Lead recovery (spec 9.3-9.7): MANAGE = author and test recovery rules; APPROVE = activate a high-impact rule
  // (never the rule's author, spec 21.3); ASSIGN = give a case to a recovery employee.
  ...mod("recovery", "lead recovery cases and rules", ["VIEW", "CREATE", "EDIT", "ASSIGN", "APPROVE", "MANAGE"]),
  // Generic follow-up tasks (spec 5.6, 5.9, 9.3).
  ...mod("follow_ups", "follow-up tasks", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
];

export const permissionKey = (p: Pick<PermissionDef, "module" | "action">) =>
  `${p.module}.${p.action.toLowerCase()}`;

const KNOWN_PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map(permissionKey));

/** True when `key` (`module.action`) is in the catalog. Unknown keys are never granted. */
export const isPermissionKey = (key: string): boolean => KNOWN_PERMISSION_KEYS.has(key);

/**
 * Field-level sensitive categories (spec 4.2 "sensitive data category"). A category is a named set
 * of fields inside a module's records. Access is decided by the module's VIEW grant plus its
 * `conditions` (see conditions.ts): a grant limited to another field set, or one that excludes this
 * set, does not reveal these fields. Keep docs/PERMISSIONS.md in sync.
 */
export const SENSITIVE_FIELD_CATEGORIES = [
  {
    key: "employees.financial_fields",
    module: "employees",
    tag: "financial",
    description: "Pay, bank and other financial fields of employee records",
  },
  {
    key: "customers.billing_fields",
    module: "customers",
    tag: "billing",
    description: "Billing and payment fields of customer records",
  },
  {
    key: "jobs.financial_fields",
    module: "jobs",
    tag: "financial",
    description: "Prices, margins and other financial fields of jobs",
  },
  {
    key: "location.coordinate_fields",
    module: "location",
    tag: "coordinates",
    description: "Raw latitude / longitude of location events (spec 22.2); a plain location.view grant never reveals them",
  },
] as const;

export type FieldCategoryKey = (typeof SENSITIVE_FIELD_CATEGORIES)[number]["key"];
