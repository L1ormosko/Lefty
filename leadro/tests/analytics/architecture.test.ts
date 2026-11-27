import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Separability and read-only invariants of the analytics module (spec 2; PLAN-phase6 "Separability"): its code never writes a
 * business table and reads data through the reporting read client only.
 */
const MODULE = path.resolve(__dirname, "../../src/server/analytics");
const BUSINESS_MODULES = ["jobs", "leads", "dispatch", "employees", "ledger", "payments", "recovery", "organization", "authz", "field-execution"];
const sources = readdirSync(MODULE)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(path.join(MODULE, name), "utf8") }));

describe("src/server/analytics", () => {
  it("calls no Prisma write method", () => {
    const write = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
    for (const source of sources) expect(source.text, source.name).not.toMatch(write);
  });

  it("runs raw SQL only to make the read transaction read-only and bind the tenant", () => {
    for (const source of sources) {
      for (const match of source.text.matchAll(/\$(executeRaw|queryRaw)(Unsafe)?`([^`]*)`/g)) {
        expect(["SET TRANSACTION READ ONLY", "SELECT set_config('app.tenant_id', ${tenantId}, true)"], source.name).toContain(match[3]);
      }
      expect(source.text, source.name).not.toMatch(/\$(executeRawUnsafe|queryRawUnsafe)/);
    }
  });

  it("is not imported by the modules that run the business (analytics only reads them)", () => {
    const serverRoot = path.resolve(MODULE, "..");
    for (const moduleName of BUSINESS_MODULES) {
      for (const file of readdirSync(path.join(serverRoot, moduleName)).filter((name) => name.endsWith(".ts"))) {
        expect(readFileSync(path.join(serverRoot, moduleName, file), "utf8"), `${moduleName}/${file}`).not.toContain("@/server/analytics");
      }
    }
  });
});
