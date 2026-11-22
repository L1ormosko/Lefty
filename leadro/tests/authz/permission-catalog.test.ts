import { describe, it, expect, afterAll } from "vitest";
import { PERMISSION_CATALOG, permissionKey, SENSITIVE_FIELD_CATEGORIES } from "@/server/authz";
import { prisma } from "@/server/db";

describe("permission catalog", () => {
  it("has unique keys", () => {
    const keys = PERMISSION_CATALOG.map(permissionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the Permission table enum values and can be upserted", async () => {
    for (const def of PERMISSION_CATALOG) {
      await prisma.permission.upsert({
        where: { key: permissionKey(def) },
        update: {},
        create: { key: permissionKey(def), module: def.module, action: def.action, sensitive: def.sensitive ?? false },
      });
    }
    expect(await prisma.permission.count()).toBe(PERMISSION_CATALOG.length);
  });

  it("defines the Phase 2 modules with the documented actions", () => {
    const actionsOf = (module: string) =>
      PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action).sort();
    expect(actionsOf("qualifications")).toEqual(["APPROVE", "ARCHIVE", "CREATE", "EDIT", "MANAGE", "VIEW"]);
    expect(actionsOf("notifications")).toEqual(["EDIT", "VIEW"]);
    expect(actionsOf("job_types")).toEqual(["CONFIGURE", "VIEW"]);
    expect(actionsOf("customers")).toContain("MANAGE");
    expect(actionsOf("leads")).toContain("MANAGE");
    // The billing field set exists for customers and the financial set for jobs (opt-in, see PERMISSIONS.md).
    const tags = SENSITIVE_FIELD_CATEGORIES.map((category) => `${category.module}:${category.tag}`);
    expect(tags).toEqual(expect.arrayContaining(["customers:billing", "jobs:financial"]));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
