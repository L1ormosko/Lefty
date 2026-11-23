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

  it("defines the Phase 3 modules with the documented actions and a sensitive location history", () => {
    const actionsOf = (module: string) =>
      PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action).sort();
    expect(actionsOf("shifts")).toEqual(["APPROVE", "CREATE", "EDIT", "VIEW"]);
    expect(actionsOf("location")).toEqual(["APPROVE", "CREATE", "VIEW"]);
    expect(actionsOf("job_outcomes")).toEqual(["CONFIGURE", "CREATE", "EDIT", "VIEW"]);
    expect(actionsOf("completion_forms")).toEqual(["CONFIGURE", "VIEW"]);
    expect(actionsOf("recovery")).toEqual(["APPROVE", "ASSIGN", "CREATE", "EDIT", "MANAGE", "VIEW"]);
    expect(actionsOf("follow_ups")).toEqual(["ASSIGN", "CREATE", "EDIT", "VIEW"]);
    // Location history is sensitive (spec 22.2): reading or approving it is a sensitive permission, recording one's own event is not.
    const sensitive = (key: string) => PERMISSION_CATALOG.find((p) => permissionKey(p) === key)?.sensitive;
    expect(sensitive("location.view")).toBe(true);
    expect(sensitive("location.approve")).toBe(true);
    expect(sensitive("location.create")).toBe(false);
    // Raw coordinates are an opt-in field set on top of location.view.
    const tags = SENSITIVE_FIELD_CATEGORIES.map((category) => `${category.module}:${category.tag}`);
    expect(tags).toContain("location:coordinates");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
