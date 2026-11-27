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
  // Phase 5: approving the publication of a performance metric definition (not one of spec 4.3's ten; see PERMISSIONS.md 12).
  "PUBLISH",
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
  // Performance (spec 10.2-10.4; development use only, spec 10.3). VIEW reads metric values (coaching content around them is the
  // opt-in `coaching` set), EDIT adds manager context to a value or period, MANAGE runs a computation, CONFIGURE authors metric
  // definition versions and submits them, PUBLISH is the approver permission of a definition's publication (never its author).
  ...mod("performance", "performance data", ["VIEW", "EDIT", "EXPORT", "MANAGE", "CONFIGURE", "PUBLISH"], ["EXPORT", "PUBLISH"]),

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

  // ── Phase 4: financial core (spec Part 11, 21.3) ──
  // Material catalog. VIEW lists materials and units; costs are the opt-in `cost` field set (`materials.cost_fields`).
  // CREATE proposes a cost version, EDIT changes catalog data, APPROVE decides a cost change (an approval policy's approver).
  ...mod("materials", "material catalog and costs", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "APPROVE", "EXPORT"], ["APPROVE", "EXPORT"]),
  // The money ledger (spec 11.8): read-only for everyone; entries are only ever posted by services. Finance never gains
  // operational permissions (spec 26.3): none of the finance_* modules grants anything on jobs, dispatch or employees.
  ...mod("finance_ledger", "the money ledger", ["VIEW", "EXPORT"], ["VIEW", "EXPORT"]),
  // CREATE records a payment, EDIT marks one failed or voids it.
  ...mod("finance_payments", "payments", ["VIEW", "CREATE", "EDIT"], ["CREATE", "EDIT"]),
  // CREATE requests a refund; APPROVE is the permission an approval policy names as approver.
  ...mod("finance_refunds", "refunds", ["VIEW", "CREATE", "APPROVE"], ["CREATE", "APPROVE"]),
  // CREATE records a chargeback, EDIT moves it through its dispute, APPROVE decides a write-off.
  ...mod("finance_chargebacks", "chargebacks", ["VIEW", "CREATE", "EDIT", "APPROVE"], ["CREATE", "EDIT", "APPROVE"]),
  ...mod("finance_adjustments", "ledger adjustments", ["VIEW", "CREATE", "APPROVE"], ["CREATE", "APPROVE"]),
  // CREATE starts a run, ASSIGN gives an exception to someone, EDIT resolves it, EXPORT downloads a run.
  ...mod("finance_reconciliation", "financial reconciliation", ["VIEW", "CREATE", "EDIT", "ASSIGN", "EXPORT"], ["EXPORT"]),
  // Approval engine (spec 21.3). Who may DECIDE a request is the policy's `approverPermission`, not this module:
  // VIEW = the approver queue and own requests, MANAGE = see every request in scope and cancel others', CONFIGURE = policies.
  ...mod("approvals", "approval requests and policies", ["VIEW", "MANAGE", "CONFIGURE"], ["CONFIGURE"]),

  // ── Phase 5: workforce intelligence (spec Part 10, 5.4, 5.8, 5.11, 22.2) ──
  // Employees read their own training, plans, shared coaching notes and challenges through self-service paths (`/api/v1/me/*`),
  // which filter on the caller; these module permissions are for the people who manage others.
  // Training: VIEW records / assignments, CREATE records a completion, EDIT changes an assignment (due date, cancel), ASSIGN
  // assigns a course (also: accepts or dismisses a training recommendation), APPROVE verifies / rejects / revokes a record (HR),
  // MANAGE = the course catalog.
  ...mod("training", "training courses, assignments and records", ["VIEW", "CREATE", "EDIT", "ASSIGN", "APPROVE", "MANAGE"]),
  // Development plans with goals, actions and review history. EDIT includes adding a review entry.
  ...mod("development_plans", "development plans", ["VIEW", "CREATE", "EDIT"], ["VIEW"]),
  // Coaching notes (sensitive, spec 22.2): the employee's management chain and HR.
  ...mod("coaching", "coaching notes", ["VIEW", "CREATE", "EDIT"], ["VIEW"]),
  // Employee challenges of their own data (raised through self-service): ASSIGN gives one to a reviewer, APPROVE upholds it,
  // REJECT rejects it with a reason. Nobody reviews their own challenge (service check + CHECK constraint).
  ...mod("data_challenges", "employee data challenges", ["VIEW", "ASSIGN", "APPROVE", "REJECT"], ["VIEW"]),
  // Manually recorded customer feedback (no survey provider). EDIT voids a mis-recorded entry.
  ...mod("customer_feedback", "customer feedback", ["VIEW", "CREATE", "EDIT"]),

  // ── Phase 6: enterprise analytics (spec Part 13, 13.5, 22.2) ──
  // One VIEW per dashboard family (`analytics_<family>.view`). A family permission opens that family's dashboards only: every KPI
  // on them still checks its own required permission and field set (financial KPIs: finance permissions + the financial set), so a
  // family grant never reveals data its holder could not read otherwise. Financial dashboards are sensitive (spec 22.2).
  ...mod("analytics_executive", "executive dashboards", ["VIEW"]),
  ...mod("analytics_operational", "operational dashboards", ["VIEW"]),
  ...mod("analytics_financial", "financial dashboards", ["VIEW"], ["VIEW"]),
  ...mod("analytics_lead", "lead dashboards", ["VIEW"]),
  // Report builder (spec 13.5). VIEW runs reports and the caller's own and role-shared saved views; CREATE saves views (and edits /
  // archives the caller's own); EXPORT exports rows, which also needs the dataset's own export permission (e.g. jobs.export) and is
  // always audited; MANAGE shares views with roles and archives other people's views in scope. Running a view always uses the
  // runner's own permissions, scope and field sets.
  ...mod("reports", "report builder and saved views", ["VIEW", "CREATE", "EXPORT", "MANAGE"], ["EXPORT"]),

  // ── Phase 7: integrations and automation (spec Part 15, Part 18, 11.9) ──
  // Background jobs of the tenant (system jobs belong to the platform and are not visible to any tenant): VIEW lists jobs and
  // scheduled definitions, MANAGE retries a dead job and enables / disables the tenant's scheduled definitions.
  ...mod("background_jobs", "background jobs and schedules", ["VIEW", "MANAGE"]),
  // Automation rules (spec 15.1-15.2). VIEW reads rules, versions and the execution log; CONFIGURE authors versions, runs dry runs,
  // activates a low-impact version and retires versions; APPROVE is the approver permission of a high-impact activation (never its
  // author, approval engine).
  ...mod("automation", "automation rules", ["VIEW", "CONFIGURE", "APPROVE"], ["CONFIGURE", "APPROVE"]),
  // Integrations (spec 18.1): VIEW reads integrations, status, error logs and inbound webhook events (never a secret: only the
  // credentials reference exists); CONFIGURE creates / edits the configuration and credentials reference, runs connection tests,
  // enables / disables; MANAGE replays a failed inbound event and resets an open circuit.
  ...mod("integrations", "integrations and webhooks", ["VIEW", "CONFIGURE", "MANAGE"], ["CONFIGURE"]),
  // Payroll exports (spec 11.9): time and attendance facts only, never wages. CREATE prepares a batch for a period, APPROVE is the
  // approver permission of its release, EXPORT downloads / sends an approved batch.
  ...mod("payroll_exports", "payroll exports (time facts)", ["VIEW", "CREATE", "APPROVE", "EXPORT"], ["VIEW", "APPROVE", "EXPORT"]),
  // Accounting exports: CONFIGURE authors and submits account mapping versions, APPROVE is the approver permission of a mapping's
  // activation, CREATE prepares a journal export for a period, EXPORT downloads / sends it.
  ...mod("accounting_exports", "accounting exports and account mappings", ["VIEW", "CREATE", "EXPORT", "APPROVE", "CONFIGURE"], ["VIEW", "EXPORT", "APPROVE", "CONFIGURE"]),
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
    key: "job_outcomes.financial_fields",
    module: "job_outcomes",
    tag: "financial",
    description: "Amounts, currency and payment of visit outcomes (spec 9.1); a plain job_outcomes.view grant never reveals them",
  },
  {
    key: "materials.cost_fields",
    module: "materials",
    tag: "cost",
    description: "Unit costs and cost history of materials (spec 11.4); a plain materials.view grant never reveals them",
  },
  {
    key: "performance.coaching_fields",
    module: "performance",
    tag: "coaching",
    description:
      "Coaching content around performance data (manager context notes; coaching notes, plans and challenges inside development read models, spec 10.4, 22.2); a plain performance.view grant never reveals it",
  },
  {
    key: "location.coordinate_fields",
    module: "location",
    tag: "coordinates",
    description: "Raw latitude / longitude of location events (spec 22.2); a plain location.view grant never reveals them",
  },
] as const;

export type FieldCategoryKey = (typeof SENSITIVE_FIELD_CATEGORIES)[number]["key"];
