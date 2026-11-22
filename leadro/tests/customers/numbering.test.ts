import { afterAll, describe, expect, it } from "vitest";
import { nextNumber } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { createTenant } from "../helpers";

afterAll(() => prisma.$disconnect());

describe("nextNumber", () => {
  it("counts 1, 2, 3 per tenant and per sequence, independently", async () => {
    const [a, b] = [await createTenant("num-a"), await createTenant("num-b")];
    const next = (tenantId: string, name: "customer" | "lead" | "job") => withTenant(tenantId, (tx) => nextNumber(tx, tenantId, name));
    expect([await next(a.id, "customer"), await next(a.id, "customer"), await next(a.id, "customer")]).toEqual([1, 2, 3]);
    expect(await next(a.id, "lead")).toBe(1);
    expect(await next(b.id, "customer")).toBe(1);
  });

  it("never hands the same number to two concurrent callers, including the first call of a tenant", async () => {
    const tenant = await createTenant("num-race");
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () => withTenant(tenant.id, (tx) => nextNumber(tx, tenant.id, "customer"))),
    );
    expect(new Set(numbers).size).toBe(8);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(8);
  });

  it("a rolled-back transaction leaves a gap instead of reusing the number", async () => {
    const tenant = await createTenant("num-gap");
    await expect(
      withTenant(tenant.id, async (tx) => {
        await nextNumber(tx, tenant.id, "customer");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await withTenant(tenant.id, (tx) => nextNumber(tx, tenant.id, "customer"))).toBe(1);
  });
});
