import type { ScopeType } from "@prisma/client";
import type { GrantConditions } from "./conditions";
import {
  PERMISSION_CATALOG,
  SENSITIVE_FIELD_CATEGORIES,
  isPermissionKey,
  permissionKey,
  type PermissionActionName,
} from "./permission-catalog";

/**
 * Default role templates (spec 4.4) derived from the 4.5 matrix; mapping rationale in
 * docs/PERMISSIONS.md section 5. Templates are copied into each tenant as ordinary, editable
 * roles (`provisionRoleTemplates`); after that the tenant's own role is the truth.
 *
 * Scopes belong to a role ASSIGNMENT, not to the role, so a template lists only permissions plus
 * the scope types an assignment of it should normally be created with (`suggestedScopeTypes`).
 */
export interface TemplateGrant {
  permission: string;
  conditions?: GrantConditions;
}

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  /** Holders must pass MFA. Enforced by authentication (it reads `Role.requiresMfa`). */
  requiresMfa: boolean;
  suggestedScopeTypes: ScopeType[];
  grants: TemplateGrant[];
}

/** Roles that always require MFA regardless of their permissions: they see or move money/people data. */
const ALWAYS_REQUIRE_MFA = new Set(["OWNER_CEO", "FINANCE_DIRECTOR", "HR_MANAGER"]);

/**
 * Sensitive administration: managing/assigning permissions or configuring any module. A role
 * holding one of these requires MFA however it is named, because it can change who may do what.
 */
export function isMfaTriggeringPermission(key: string): boolean {
  return key === "permissions.manage" || key === "permissions.assign" || key.endsWith(".configure");
}

const SENSITIVE_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.filter((entry) => entry.sensitive).map(permissionKey),
);
const SENSITIVE_FIELD_TAGS: ReadonlySet<string> = new Set(SENSITIVE_FIELD_CATEGORIES.map((category) => category.tag));

/**
 * Does this grant reveal something sensitive? Same meaning of "sensitive" as the permission module's
 * lock-out and escalation rules (`Permission.sensitive`), plus the sensitive field sets (financial,
 * billing) a grant can opt into with `includeFields` or be limited to with `fields`.
 */
function isSensitiveGrant(grant: TemplateGrant): boolean {
  if (isMfaTriggeringPermission(grant.permission) || SENSITIVE_PERMISSION_KEYS.has(grant.permission)) return true;
  const conditions = grant.conditions;
  if (!conditions) return false;
  return (
    (conditions.fields !== undefined && SENSITIVE_FIELD_TAGS.has(conditions.fields)) ||
    (conditions.includeFields ?? []).some((tag) => SENSITIVE_FIELD_TAGS.has(tag))
  );
}

/** MFA rule for a template: explicit sensitive roles, or any role holding a triggering permission. */
export function templateRequiresMfa(key: string, grants: TemplateGrant[]): boolean {
  return ALWAYS_REQUIRE_MFA.has(key) || grants.some((grant) => isMfaTriggeringPermission(grant.permission));
}

/**
 * MFA rule for a CUSTOM role: the template rule, or ANY sensitive grant (a `Permission.sensitive`
 * permission, or a sensitive field set). This is the same meaning of "sensitive" the lock-out and
 * escalation rules use, so a custom role cannot hold what those rules protect without MFA. It is
 * computed on every custom-role save. The shipped templates keep `templateRequiresMfa` (their
 * operational roles, e.g. Technician, deliberately do not require MFA by default).
 */
export function customRoleRequiresMfa(grants: TemplateGrant[]): boolean {
  return templateRequiresMfa("", grants) || grants.some(isSensitiveGrant);
}

// ───────── Builders (fail fast on a typo: every key must exist in the catalog) ─────────

function grantActions(
  module: string,
  actions: PermissionActionName[],
  conditions?: GrantConditions,
): TemplateGrant[] {
  return actions.map((action) => {
    const key = `${module}.${action.toLowerCase()}`;
    if (!isPermissionKey(key)) throw new Error(`Role template references unknown permission "${key}"`);
    return conditions ? { permission: key, conditions } : { permission: key };
  });
}

/** Every action the catalog defines for the module ("Full" in the matrix). */
function full(module: string, conditions?: GrantConditions): TemplateGrant[] {
  const actions = PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action);
  return grantActions(module, actions, conditions);
}

const view = (module: string, conditions?: GrantConditions) => grantActions(module, ["VIEW"], conditions);

/** A user's own notifications: read, mark read, change preferences. Every template holds it. */
const own = (module: string) => grantActions(module, ["VIEW", "EDIT"]);

function defineTemplate(template: Omit<RoleTemplate, "requiresMfa">): RoleTemplate {
  return { ...template, requiresMfa: templateRequiresMfa(template.key, template.grants) };
}

// ───────── Shared grant bundles ─────────

/** What a State, Regional or City manager may do inside the unit they are assigned to. */
const unitManagerGrants = (): TemplateGrant[] => [
  ...view("localization"),
  ...grantActions("organization", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  ...grantActions("employees", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  ...grantActions("customers", ["VIEW", "CREATE", "EDIT"]),
  ...grantActions("leads", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  ...grantActions("dispatch", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  ...grantActions("jobs", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  ...view("compensation"),
  ...view("financial_reports"),
  ...view("performance"),
  ...grantActions("qualifications", ["VIEW", "CREATE", "EDIT"]),
  ...view("job_types"),
  ...own("notifications"),
  // Phase 3: oversee shifts and arrivals (verifying one is a manager's call, spec 8.4), correct outcomes, run follow-ups.
  // Location history is read without coordinates (the `coordinates` set is opt-in).
  ...grantActions("shifts", ["VIEW", "EDIT", "APPROVE"]),
  ...grantActions("location", ["VIEW", "APPROVE"]),
  // Managers see and correct outcome money: the financial set is named explicitly (opt-in, like jobs.financial_fields).
  ...grantActions("job_outcomes", ["VIEW", "EDIT"], { includeFields: ["financial"] }),
  ...view("completion_forms"),
  ...view("recovery"),
  ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
  // Phase 4: scoped, mostly read-only finance for the unit. They request refunds and adjustments (a finance approver decides)
  // and see reconciliation and the approval queue, but cannot record payments, decide, export or see material costs.
  ...view("materials"),
  ...view("finance_ledger"),
  ...view("finance_payments"),
  ...grantActions("finance_refunds", ["VIEW", "CREATE"]),
  ...view("finance_chargebacks"),
  ...grantActions("finance_adjustments", ["VIEW", "CREATE"]),
  ...view("finance_reconciliation"),
  ...view("approvals"),
];

export const ROLE_TEMPLATES: RoleTemplate[] = [
  defineTemplate({
    key: "OWNER_CEO",
    name: "Owner / CEO",
    description: "Company-wide overview, organization structure, system configuration and high-level approvals.",
    suggestedScopeTypes: ["TENANT"],
    // "Full" includes the sensitive field sets (financial, billing); they are opt-in for everyone else.
    grants: PERMISSION_CATALOG.flatMap((p) => {
      const sensitive = SENSITIVE_FIELD_CATEGORIES.find((category) => category.module === p.module);
      return grantActions(p.module, [p.action], sensitive ? { includeFields: [sensitive.tag] } : undefined);
    }),
  }),
  defineTemplate({
    key: "COO",
    name: "COO / VP Operations",
    description: "Operational performance, dispatch oversight and job lifecycle across the company.",
    suggestedScopeTypes: ["TENANT"],
    grants: [
      ...view("localization"),
      ...grantActions("company_settings", ["VIEW", "EDIT"]),
      ...view("organization"),
      ...grantActions("employees", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
      ...grantActions("customers", ["VIEW", "CREATE", "EDIT"]),
      ...view("leads"),
      ...full("dispatch"),
      ...full("jobs"),
      ...view("qualifications"),
      ...full("job_types"),
      // Phase 3: operational oversight and the policies behind it (forms, lost reasons, recovery rules + their approval).
      // No location coordinates: only the Owner's template opts into that set.
      ...full("shifts"),
      ...grantActions("location", ["VIEW", "APPROVE"]),
      ...full("job_outcomes", { includeFields: ["financial"] }),
      ...full("completion_forms"),
      ...full("recovery"),
      ...full("follow_ups"),
      // Phase 4: the COO maintains the material catalog (no costs: the `cost` set is Owner / Finance only, like every other
      // sensitive field set) and oversees finance read-only; money movements and their approval belong to the Finance Director.
      ...grantActions("materials", ["VIEW", "CREATE", "EDIT", "ARCHIVE"]),
      ...view("finance_ledger"),
      ...view("finance_payments"),
      ...view("finance_refunds"),
      ...view("finance_chargebacks"),
      ...view("finance_adjustments"),
      ...view("finance_reconciliation"),
      ...grantActions("approvals", ["VIEW", "MANAGE"]),
      ...own("notifications"),
      ...view("compensation"),
      ...view("financial_reports"),
      ...view("performance"),
      ...view("permissions"),
      // "Limited": may assign roles, but only non-sensitive ones. The permissions module enforces it.
      ...grantActions("permissions", ["ASSIGN"], { set: "non_sensitive_roles" }),
    ],
  }),
  defineTemplate({
    key: "FINANCE_DIRECTOR",
    name: "Finance Director",
    description:
      "Financial records, compensation, adjustments and financial approvals. No operational management (spec 4.4).",
    suggestedScopeTypes: ["TENANT"],
    grants: [
      ...view("localization"),
      ...view("employees", { fields: "financial" }),
      ...view("customers", { fields: "billing" }),
      ...view("jobs", { fields: "financial" }),
      ...view("job_outcomes", { fields: "financial" }),
      ...own("notifications"),
      ...full("compensation"),
      ...full("financial_reports"),
      // Phase 4: full finance (ledger, payments, refunds, chargebacks, adjustments, reconciliation, approval policies) and the
      // material catalog's costs. Deliberately NO dispatch, jobs.edit or employees.edit: Finance does not gain operational
      // permissions (spec 26.3), and `materials` is view + approve only, never catalog editing.
      ...full("finance_ledger"),
      ...full("finance_payments"),
      ...full("finance_refunds"),
      ...full("finance_chargebacks"),
      ...full("finance_adjustments"),
      ...full("finance_reconciliation"),
      ...grantActions("materials", ["VIEW", "APPROVE", "EXPORT"], { includeFields: ["cost"] }),
      ...full("approvals"),
    ],
  }),
  defineTemplate({
    key: "STATE_MANAGER",
    name: "State Manager",
    description: "Everything inside the assigned state: regional and city managers, employees, jobs and leads.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: unitManagerGrants(),
  }),
  defineTemplate({
    key: "REGIONAL_MANAGER",
    name: "Regional Manager",
    description: "Assigned regions and the cities within them. Derived from State Manager (confirm in DECISIONS.md).",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: unitManagerGrants(),
  }),
  defineTemplate({
    key: "CITY_MANAGER",
    name: "City Manager",
    description: "Assigned city: employees, teams, local jobs and leads.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: unitManagerGrants(),
  }),
  defineTemplate({
    key: "TEAM_LEADER",
    name: "Team Leader",
    description: "Assigned team: schedules, jobs and performance. Read-mostly (derived from City Manager).",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: [
      ...view("localization"),
      ...view("organization"),
      ...view("employees"),
      ...view("customers"),
      ...view("leads"),
      ...view("dispatch"),
      ...grantActions("jobs", ["VIEW", "EDIT"]),
      ...view("qualifications"),
      ...view("job_types"),
      ...own("notifications"),
      ...view("performance"),
      ...view("shifts"),
      ...view("job_outcomes"),
      ...view("completion_forms"),
      ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT"]),
      ...view("materials"),
    ],
  }),
  defineTemplate({
    key: "LEAD_OPERATIONS_MANAGER",
    name: "Lead Operations Manager",
    description: "Lead queues, lead employees, assignment, follow-up, recovery and lead sources. No lead archiving.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: [
      ...view("localization"),
      ...grantActions("employees", ["VIEW", "ASSIGN"], { set: "lead_team" }),
      ...grantActions("customers", ["VIEW", "CREATE", "EDIT"], { set: "lead_related" }),
      ...grantActions("leads", ["VIEW", "CREATE", "EDIT", "ASSIGN", "EXPORT", "MANAGE"]),
      ...view("dispatch"),
      ...view("jobs", { set: "recovery_related" }),
      ...view("job_types"),
      ...own("notifications"),
      ...view("performance", { set: "lead_team" }),
      // Phase 3: lead recovery (spec 4.4). Authors rules (manage) but cannot activate a high-impact one (approve is COO/Owner).
      // Technician presence arrives inside the case as a status; Lead Ops holds no location permission.
      ...grantActions("recovery", ["VIEW", "CREATE", "EDIT", "ASSIGN", "MANAGE"]),
      ...view("job_outcomes"),
      ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
    ],
  }),
  defineTemplate({
    key: "DISPATCHER",
    name: "Dispatcher",
    description: "Dispatch board, employee availability, job assignment and scheduling. Cannot configure anything.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: [
      ...view("localization"),
      ...view("employees", { fields: "availability" }),
      ...view("customers", { set: "job_related" }),
      ...view("leads", { set: "dispatch_related" }),
      ...full("dispatch"),
      // "Operational fields" = every non-sensitive job field: the financial set is opt-in and not granted here.
      ...grantActions("jobs", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
      ...view("qualifications"),
      ...view("job_types"),
      ...own("notifications"),
      // Phase 3: sees who is on shift and how visits ended; works follow-ups. No location history.
      ...view("shifts"),
      ...view("job_outcomes"),
      ...view("completion_forms"),
      ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT"]),
      ...view("materials"),
    ],
  }),
  defineTemplate({
    key: "CUSTOMER_RELATIONS",
    name: "Customer Relations",
    description: "Customer information, history, complaints and follow-ups within the assigned scope.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: [
      ...view("localization"),
      ...grantActions("customers", ["VIEW", "CREATE", "EDIT"]),
      ...view("leads"),
      // Service history (spec 5.9): only jobs of customers in their scope, requested through the customer history view.
      ...view("jobs", { set: "customer_history" }),
      ...view("job_types"),
      ...own("notifications"),
      // Phase 3: "Follow-up tasks" are part of the role (spec 4.4).
      ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT", "ASSIGN"]),
    ],
  }),
  defineTemplate({
    key: "HR_MANAGER",
    name: "HR Manager",
    description: "Employee records, employment information, training and development. No financial fields.",
    suggestedScopeTypes: ["TENANT"],
    grants: [
      ...view("localization"),
      ...view("organization"),
      // No `includeFields`: HR sees personal/employment fields but not financial ones (opt-in).
      ...full("employees"),
      // Credentials and licenses are HR records (spec 10.1): HR verifies them (qualifications.approve).
      ...full("qualifications"),
      ...own("notifications"),
      ...view("performance"),
    ],
  }),
  defineTemplate({
    key: "TECHNICIAN",
    name: "Technician / Sales Representative",
    description: "Own profile, shift, assigned jobs, necessary customer information and own statements.",
    // OWN covers profile and statements; ASSIGNED covers jobs/customers/leads assigned to them.
    suggestedScopeTypes: ["OWN", "ASSIGNED"],
    grants: [
      ...view("localization"),
      ...view("employees"),
      // Assigned customers: contact and address; never the billing set (opt-in, not granted).
      ...view("customers"),
      ...view("leads"),
      // May change only the lead's status (the leads service allows just the `status` field set).
      ...grantActions("leads", ["EDIT"], { fields: "status" }),
      ...view("dispatch"),
      ...view("jobs"),
      // May change only execution fields of an assigned job (status progression, notes), never scheduling or money.
      ...grantActions("jobs", ["EDIT"], { fields: "execution" }),
      ...view("qualifications"),
      ...view("job_types"),
      ...own("notifications"),
      ...view("compensation"),
      // No financial_reports.view: own statements/summary are self-service, not the module permission.
      ...view("performance"),
      // Phase 3 (OWN / ASSIGNED scopes): own shift, own location events (recording only, no history, no verification),
      // outcomes of assigned jobs, the completion form to fill in, follow-ups assigned to them.
      ...grantActions("shifts", ["VIEW", "CREATE", "EDIT"]),
      ...grantActions("location", ["CREATE"]),
      // The technician reports amounts and payment, so they hold the financial set on the outcomes of their own jobs.
      ...grantActions("job_outcomes", ["VIEW", "CREATE"], { includeFields: ["financial"] }),
      ...view("completion_forms"),
      ...grantActions("follow_ups", ["VIEW", "CREATE", "EDIT"]),
      // Phase 4: the material names and units to pick from when recording usage; never costs.
      ...view("materials"),
    ],
  }),
];
