import { describe, expect, it } from "vitest";
import {
  CustomerFeedbackChannel,
  DataChallengeResolution,
  DataChallengeStatus,
  DataChallengeTargetType,
  DevelopmentActionKind,
  DevelopmentActionStatus,
  DevelopmentGoalStatus,
  DevelopmentPlanStatus,
  PerformanceDimension,
  PerformanceMetricKind,
  PerformanceMetricStatus,
  TrainingAssignmentSource,
  TrainingAssignmentStatus,
  TrainingRecommendationStatus,
  TrainingRecordStatus,
} from "@prisma/client";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { PERMISSION_ACTIONS, PERMISSION_CATALOG, ROLE_TEMPLATES, SENSITIVE_FIELD_CATEGORIES } from "@/server/authz";
import { APPROVAL_SUBJECT_TYPES } from "@/server/approvals/schemas";
import { APPROVAL_POLICY_SPECS } from "../../prisma/seed/finance-specs";

const PHASE5_MODULES = ["training", "development_plans", "coaching", "data_challenges", "customer_feedback"];
const DEVELOPMENT_MODULES = ["training", "development_plans", "coaching", "data_challenges"];
const MANAGERS = ["STATE_MANAGER", "REGIONAL_MANAGER", "CITY_MANAGER"];

const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};
const holds = (key: string, permission: string) => template(key).grants.some((g) => g.permission === permission);
const grant = (key: string, permission: string) => template(key).grants.find((g) => g.permission === permission);
const modulesOf = (key: string) => new Set(template(key).grants.map((g) => g.permission.split(".")[0]));
const actions = (module: string) => PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action);
const sensitive = (key: string) => PERMISSION_CATALOG.find((p) => `${p.module}.${p.action.toLowerCase()}` === key)?.sensitive;
const seesCoaching = (key: string) => grant(key, "performance.view")?.conditions?.includeFields?.includes("coaching") ?? false;

describe("Phase 5 permission catalog", () => {
  it("adds the workforce modules and extends performance with EDIT, MANAGE, CONFIGURE and PUBLISH", () => {
    expect(actions("performance")).toEqual(["VIEW", "EDIT", "EXPORT", "MANAGE", "CONFIGURE", "PUBLISH"]);
    expect(actions("training")).toEqual(["VIEW", "CREATE", "EDIT", "ASSIGN", "APPROVE", "MANAGE"]);
    expect(actions("development_plans")).toEqual(["VIEW", "CREATE", "EDIT"]);
    expect(actions("coaching")).toEqual(["VIEW", "CREATE", "EDIT"]);
    expect(actions("data_challenges")).toEqual(["VIEW", "ASSIGN", "APPROVE", "REJECT"]);
    expect(actions("customer_feedback")).toEqual(["VIEW", "CREATE", "EDIT"]);
    expect(PERMISSION_ACTIONS).toContain("PUBLISH");
  });

  it("marks reading coaching notes, plans and challenges, publishing and exporting performance as sensitive", () => {
    for (const key of ["coaching.view", "development_plans.view", "data_challenges.view", "performance.publish", "performance.export"]) {
      expect(sensitive(key), key).toBe(true);
    }
    for (const key of ["performance.view", "training.view", "customer_feedback.view"]) expect(sensitive(key), key).toBe(false);
  });

  it("has the opt-in `coaching` field set on performance", () => {
    expect(SENSITIVE_FIELD_CATEGORIES.find((c) => c.key === "performance.coaching_fields")).toMatchObject({ module: "performance", tag: "coaching" });
  });

  it("can route metric publication through the approval engine", () => {
    expect(APPROVAL_SUBJECT_TYPES).toContain("PERFORMANCE_METRIC_DEFINITION");
    const policy = APPROVAL_POLICY_SPECS.find((p) => p.subjectType === "PERFORMANCE_METRIC_DEFINITION");
    expect(policy?.approverPermission).toBe("performance.publish");
  });
});

describe("Phase 5 role templates (spec 4.5 Performance row, 5.4, 5.8, 5.11)", () => {
  it("gives the Owner every new permission, with the coaching set on performance", () => {
    for (const p of PERMISSION_CATALOG.filter((x) => PHASE5_MODULES.includes(x.module) || x.module === "performance")) {
      expect(holds("OWNER_CEO", `${p.module}.${p.action.toLowerCase()}`), `${p.module}.${p.action}`).toBe(true);
    }
    expect(seesCoaching("OWNER_CEO")).toBe(true);
  });

  it("gives the executive (COO) metric values only: no coaching set, no coaching notes, plans or challenges", () => {
    expect(holds("COO", "performance.view")).toBe(true);
    expect(seesCoaching("COO")).toBe(false);
    for (const p of ["performance.edit", "performance.configure", "performance.publish", "coaching.view", "development_plans.view", "data_challenges.view"]) {
      expect(holds("COO", p), p).toBe(false);
    }
  });

  it("gives Finance nothing on performance or development (spec 4.5: No)", () => {
    expect([...modulesOf("FINANCE_DIRECTOR")].filter((m) => m === "performance" || PHASE5_MODULES.includes(m))).toEqual([]);
  });

  it("scopes managers to their unit: values with coaching, context, plans, coaching, assigning training, routing challenges", () => {
    for (const key of MANAGERS) {
      expect(seesCoaching(key), key).toBe(true);
      for (const p of ["performance.edit", "performance.manage", "training.view", "training.assign", "development_plans.create", "development_plans.edit", "coaching.create", "data_challenges.assign", "customer_feedback.view"]) {
        expect(holds(key, p), `${key} ${p}`).toBe(true);
      }
      // HR records and verifies training and decides challenges; nobody but Owner / HR authors or publishes metric definitions.
      for (const p of ["training.create", "training.approve", "training.manage", "data_challenges.approve", "data_challenges.reject", "performance.configure", "performance.publish", "performance.export"]) {
        expect(holds(key, p), `${key} ${p}`).toBe(false);
      }
      expect(template(key).suggestedScopeTypes).toEqual(["ORG_UNIT"]);
    }
  });

  it("lets the Team Leader coach their own team, read-mostly", () => {
    expect(seesCoaching("TEAM_LEADER")).toBe(true);
    for (const p of ["performance.edit", "coaching.view", "coaching.create", "development_plans.view", "training.view"]) expect(holds("TEAM_LEADER", p), p).toBe(true);
    for (const p of ["training.assign", "development_plans.create", "data_challenges.view", "performance.manage"]) expect(holds("TEAM_LEADER", p), p).toBe(false);
  });

  it("limits Lead Operations to the lead team (spec 4.5: Lead team)", () => {
    expect(grant("LEAD_OPERATIONS_MANAGER", "performance.view")?.conditions).toEqual({ set: "lead_team", includeFields: ["coaching"] });
    for (const p of ["coaching.view", "coaching.create", "training.view"]) {
      expect(grant("LEAD_OPERATIONS_MANAGER", p)?.conditions?.set, p).toBe("lead_team");
    }
    expect(holds("LEAD_OPERATIONS_MANAGER", "development_plans.view")).toBe(false);
  });

  it("gives HR full training, plans, coaching and challenge review, and metric authoring but not publishing, still without financial data", () => {
    for (const moduleName of DEVELOPMENT_MODULES) {
      for (const action of actions(moduleName)) expect(holds("HR_MANAGER", `${moduleName}.${action.toLowerCase()}`), `${moduleName}.${action}`).toBe(true);
    }
    expect(seesCoaching("HR_MANAGER")).toBe(true);
    expect(holds("HR_MANAGER", "performance.configure")).toBe(true);
    expect(holds("HR_MANAGER", "performance.publish")).toBe(false);
    expect([...modulesOf("HR_MANAGER")].filter((m) => m.startsWith("finance_") || m === "compensation" || m === "financial_reports")).toEqual([]);
    expect(template("HR_MANAGER").grants.some((g) => g.conditions?.includeFields?.includes("financial") || g.conditions?.fields === "financial")).toBe(false);
  });

  it("gives the technician own metric values (no coaching set) and own training; the rest is self-service", () => {
    expect(holds("TECHNICIAN", "performance.view")).toBe(true);
    expect(seesCoaching("TECHNICIAN")).toBe(false);
    expect(holds("TECHNICIAN", "training.view")).toBe(true);
    for (const moduleName of ["coaching", "development_plans", "data_challenges", "customer_feedback"]) expect(modulesOf("TECHNICIAN").has(moduleName), moduleName).toBe(false);
    expect(template("TECHNICIAN").suggestedScopeTypes).toContain("OWN");
  });

  it("keeps the Dispatcher away from performance and development data (spec 10.3: never a dispatch input)", () => {
    expect([...modulesOf("DISPATCHER")].filter((m) => m === "performance" || PHASE5_MODULES.includes(m))).toEqual([]);
  });

  it("lets Customer Relations record and void customer feedback, and nothing else of Phase 5", () => {
    for (const p of ["customer_feedback.view", "customer_feedback.create", "customer_feedback.edit"]) expect(holds("CUSTOMER_RELATIONS", p), p).toBe(true);
    expect([...modulesOf("CUSTOMER_RELATIONS")].filter((m) => m === "performance" || DEVELOPMENT_MODULES.includes(m))).toEqual([]);
  });

  it("names the coaching set only for the management chain, HR and the Owner", () => {
    const naming = ROLE_TEMPLATES.filter((t) => t.grants.some((g) => g.conditions?.includeFields?.includes("coaching"))).map((t) => t.key).sort();
    expect(naming).toEqual(["CITY_MANAGER", "HR_MANAGER", "LEAD_OPERATIONS_MANAGER", "OWNER_CEO", "REGIONAL_MANAGER", "STATE_MANAGER", "TEAM_LEADER"]);
  });

  it("only the Owner can publish a metric definition by default", () => {
    expect(ROLE_TEMPLATES.filter((t) => holds(t.key, "performance.publish")).map((t) => t.key)).toEqual(["OWNER_CEO"]);
  });
});

describe("Phase 5 labels exist in every catalog", () => {
  const families: Record<string, readonly string[]> = {
    "PERMISSION_ACTION.": ["PUBLISH"],
    "APPROVAL.SUBJECT.": ["PERFORMANCE_METRIC_DEFINITION"],
    "TRAINING.ASSIGNMENT_STATUS.": Object.values(TrainingAssignmentStatus),
    "TRAINING.ASSIGNMENT_SOURCE.": Object.values(TrainingAssignmentSource),
    "TRAINING.RECORD_STATUS.": Object.values(TrainingRecordStatus),
    "TRAINING.RECOMMENDATION_STATUS.": Object.values(TrainingRecommendationStatus),
    "PERFORMANCE.KIND.": Object.values(PerformanceMetricKind),
    "PERFORMANCE.DIMENSION.": Object.values(PerformanceDimension),
    "PERFORMANCE.DEFINITION_STATUS.": Object.values(PerformanceMetricStatus),
    "DEVELOPMENT.PLAN_STATUS.": Object.values(DevelopmentPlanStatus),
    "DEVELOPMENT.GOAL_STATUS.": Object.values(DevelopmentGoalStatus),
    "DEVELOPMENT.ACTION_KIND.": Object.values(DevelopmentActionKind),
    "DEVELOPMENT.ACTION_STATUS.": Object.values(DevelopmentActionStatus),
    "DATA_CHALLENGE.TARGET.": Object.values(DataChallengeTargetType),
    "DATA_CHALLENGE.STATUS.": Object.values(DataChallengeStatus),
    "DATA_CHALLENGE.RESOLUTION.": Object.values(DataChallengeResolution),
    "CUSTOMER_FEEDBACK.CHANNEL.": Object.values(CustomerFeedbackChannel),
  };

  for (const [prefix, members] of Object.entries(families)) {
    it(`${prefix}*`, () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const member of members) expect(CATALOGS[locale].messages[`${prefix}${member}`], `${locale} ${prefix}${member}`).toBeTruthy();
      }
    });
  }
});
