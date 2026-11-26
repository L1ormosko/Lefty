import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec 10.3 for the development module: recommendations and plans are development use only. The modules that decide work,
 * pay or employment never import it, and what it takes from the qualifications module is read-only (eligibility verdicts,
 * the warning horizon), never a function that writes qualifications.
 */
const SERVER = path.resolve(__dirname, "../../src/server");
const DECIDING_MODULES = ["dispatch", "qualifications", "jobs", "ledger", "payments", "approvals", "employees", "finance-adjustments", "training", "performance"];
const READ_ONLY_QUALIFICATION_IMPORTS = new Set(["evaluateCandidates", "qualificationWarningDays", "requirementsForJobType"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("spec 10.3: development never feeds work", () => {
  it.each(DECIDING_MODULES)("src/server/%s never imports the development module", (moduleName) => {
    for (const file of sourceFiles(path.join(SERVER, moduleName))) {
      expect(readFileSync(file, "utf8"), path.relative(SERVER, file)).not.toMatch(/["']@\/server\/development["'/]|["']\.\.\/development/);
    }
  });

  it("takes only read functions from the qualifications module", () => {
    for (const file of sourceFiles(path.join(SERVER, "development"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/server\/qualifications["']/g)) {
        const names = (match[1] as string).split(",").map((name) => name.trim().replace(/^type\s+/, "")).filter(Boolean);
        for (const name of names) expect(READ_ONLY_QUALIFICATION_IMPORTS, `${path.relative(SERVER, file)} imports ${name}`).toContain(name);
      }
    }
  });
});
