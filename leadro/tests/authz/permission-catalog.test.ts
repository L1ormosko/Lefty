import { describe, it, expect, afterAll } from "vitest";
import { PERMISSION_CATALOG, permissionKey } from "@/server/authz";
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

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
