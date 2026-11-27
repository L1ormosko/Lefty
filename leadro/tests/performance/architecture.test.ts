import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec 10.3 is structural, not a policy flag: performance data never feeds dispatch eligibility, ranking, assignment,
 * compensation, commissions, suspensions or employment status. These tests read the source:
 *  1. none of the modules that make those decisions imports the performance module (by alias or relative path);
 *  2. the performance module imports only the platform modules it needs (no dispatch, jobs, employees, ledger, payments,
 *     qualifications or finance writer), so it cannot write those records either.
 */
const SERVER = path.resolve(__dirname, "../../src/server");

const DECIDING_MODULES = ["dispatch", "qualifications", "jobs", "ledger", "payments", "approvals", "employees", "finance-adjustments"];
const PERFORMANCE_ALLOWED_IMPORTS = ["@/server/approvals", "@/server/audit", "@/server/authz", "@/server/core", "@/server/db", "@/server/notifications"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const importsOf = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] as string);

describe("spec 10.3: performance data never feeds work", () => {
  it.each(DECIDING_MODULES)("src/server/%s never imports the performance module", (moduleName) => {
    const dir = path.join(SERVER, moduleName);
    const files = sourceFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        const resolved = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : specifier;
        const hitsPerformance = resolved.startsWith("@/server/performance") || resolved.startsWith(path.join(SERVER, "performance"));
        expect(hitsPerformance, `${path.relative(SERVER, file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  // Review P5-R7: an import ban alone would not stop a deciding module from reading the tables directly (`tx.performanceMetricValue`).
  // None of them names a Phase 5 performance / development delegate or table. The one allowed exception is the legal TRAINING
  // certification path in qualifications (`training-grants.ts` reads training records; spec 10.3 puts it in the Qualification Engine).
  const PHASE5_DELEGATES = [
    "performanceMetricDefinition", "performanceMetricValue", "metricContextNote", "coachingRecord", "developmentPlan", "developmentGoal",
    "developmentAction", "developmentPlanReview", "trainingRecommendation", "dataChallenge", "customerFeedback", "developmentThresholds",
  ];
  const tableName = (delegate: string) => delegate.charAt(0).toUpperCase() + delegate.slice(1);
  it.each(DECIDING_MODULES)("src/server/%s never reads performance or development tables directly", (moduleName) => {
    for (const file of sourceFiles(path.join(SERVER, moduleName))) {
      const source = readFileSync(file, "utf8");
      for (const delegate of PHASE5_DELEGATES) {
        expect(new RegExp(`\\b(${delegate}|${tableName(delegate)})\\b`).test(source), `${path.relative(SERVER, file)} names ${delegate}`).toBe(false);
      }
      if (!file.endsWith("training-grants.ts")) {
        expect(/\btx\.training(Record|Assignment|Course)\b/.test(source), `${path.relative(SERVER, file)} reads training tables`).toBe(false);
      }
    }
  });

  it("the performance module imports only platform modules (it writes nothing of dispatch, jobs, employees or finance)", () => {
    for (const file of sourceFiles(path.join(SERVER, "performance"))) {
      for (const specifier of importsOf(file).filter((value) => value.startsWith("@/server/"))) {
        expect(PERFORMANCE_ALLOWED_IMPORTS, `${path.relative(SERVER, file)} imports ${specifier}`).toContain(specifier);
      }
    }
  });
});
