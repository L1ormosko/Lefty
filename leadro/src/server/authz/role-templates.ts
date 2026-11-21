import type { ScopeType } from "@prisma/client";
import type { GrantConditions } from "./conditions";
import {
  PERMISSION_CATALOG,
  SENSITIVE_FIELD_CATEGORIES,
  isPermissionKey,
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

/** MFA rule for a template: explicit sensitive roles, or any role holding a triggering permission. */
export function templateRequiresMfa(key: string, grants: TemplateGrant[]): boolean {
  return ALWAYS_REQUIRE_MFA.has(key) || grants.some((grant) => isMfaTriggeringPermission(grant.permission));
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
      ...full("compensation"),
      ...full("financial_reports"),
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
      ...view("performance"),
    ],
  }),
  defineTemplate({
    key: "LEAD_OPERATIONS_MANAGER",
    name: "Lead Operations Manager",
    description: "Lead queues, lead employees, assignment, follow-up and recovery. No lead archiving.",
    suggestedScopeTypes: ["ORG_UNIT"],
    grants: [
      ...view("localization"),
      ...grantActions("employees", ["VIEW", "ASSIGN"], { set: "lead_team" }),
      ...grantActions("customers", ["VIEW", "CREATE", "EDIT"], { set: "lead_related" }),
      ...grantActions("leads", ["VIEW", "CREATE", "EDIT", "ASSIGN", "EXPORT"]),
      ...view("dispatch"),
      ...view("jobs", { set: "recovery_related" }),
      ...view("performance", { set: "lead_team" }),
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
      ...grantActions("jobs", ["VIEW", "CREATE", "EDIT", "ASSIGN"], { fields: "operational" }),
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
      ...view("customers", { fields: "necessary" }),
      ...grantActions("leads", ["VIEW", "EDIT"], { fields: "status" }),
      ...view("dispatch"),
      ...grantActions("jobs", ["VIEW", "EDIT"], { fields: "execution" }),
      ...view("compensation"),
      // No financial_reports.view: own statements/summary are self-service, not the module permission.
      ...view("performance"),
    ],
  }),
];
