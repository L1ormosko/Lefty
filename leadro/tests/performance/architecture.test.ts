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

  it("the performance module imports only platform modules (it writes nothing of dispatch, jobs, employees or finance)", () => {
    for (const file of sourceFiles(path.join(SERVER, "performance"))) {
      for (const specifier of importsOf(file).filter((value) => value.startsWith("@/server/"))) {
        expect(PERFORMANCE_ALLOWED_IMPORTS, `${path.relative(SERVER, file)} imports ${specifier}`).toContain(specifier);
      }
    }
  });
});
