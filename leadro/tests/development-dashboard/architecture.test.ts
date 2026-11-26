import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec 10.3 for the Phase 5 read models (Task 6): the manager development dashboard and the self-service read functions are
 * development / transparency use only. The modules that decide work, eligibility, pay or employment never import the
 * dashboard or the customer feedback module, and the dashboard only READS: it takes list / get functions from the modules it
 * composes, never a function that writes.
 */
const SERVER = path.resolve(__dirname, "../../src/server");
const DECIDING_MODULES = ["dispatch", "qualifications", "jobs", "ledger", "payments", "approvals", "employees", "finance-adjustments"];
const PHASE5_MODULES = ["training", "performance", "coaching", "data-challenges", "development"];
const READ_MODELS = ["development-dashboard", "customer-feedback"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const importsOf = (moduleName: string) => new RegExp(`["']@/server/${moduleName}["'/]|["']\\.\\./${moduleName}["'/]`);

describe("spec 10.3: the Phase 5 read models never feed work, eligibility or pay", () => {
  for (const readModel of READ_MODELS) {
    it.each(DECIDING_MODULES)(`src/server/%s never imports ${readModel}`, (moduleName) => {
      for (const file of sourceFiles(path.join(SERVER, moduleName))) {
        expect(readFileSync(file, "utf8"), path.relative(SERVER, file)).not.toMatch(importsOf(readModel));
      }
    });
  }

  it.each(PHASE5_MODULES)("src/server/%s does not depend on the dashboard composed on top of it", (moduleName) => {
    for (const file of sourceFiles(path.join(SERVER, moduleName))) {
      expect(readFileSync(file, "utf8"), path.relative(SERVER, file)).not.toMatch(importsOf("development-dashboard"));
    }
  });

  it("the dashboard imports only read functions and types from the modules it composes", () => {
    const allowedValueImports = new Set(["listEmployeeCurrentValues", "listPeerCurrentValues", "listCoachingRecords", "listContextNotes", "listPlans", "getPlan", "listRecommendations", "can", "canViewFields"]);
    for (const file of sourceFiles(path.join(SERVER, "development-dashboard"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']@\/server\/([a-z-]+)["']/g)) {
        if (match[1]) continue; // type-only import
        const names = (match[2] as string).split(",").map((name) => name.trim()).filter((name) => name && !name.startsWith("type "));
        for (const name of names) expect(allowedValueImports, `${path.relative(SERVER, file)} imports ${name} from ${match[3]}`).toContain(name);
      }
    }
  });
});
