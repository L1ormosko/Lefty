import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth";
import { isPermissionKey } from "@/server/authz";
import { prisma, withTenant } from "@/server/db";
import { APPROVAL_POLICY_SPECS, MATERIAL_SPECS } from "../../prisma/seed/finance-specs";
import { seedFinanceData, type SeedFinanceResult } from "../../prisma/seed/seed-finance";
import { seedTenant } from "../../prisma/seed/seed-tenant";
import { TENANT_SPECS } from "../../prisma/seed/tenant-specs";

const suffix = Math.random().toString(36).slice(2, 8);
const spec = { ...TENANT_SPECS[0], slug: `financeseed-a-${suffix}` };
let tenantId: string;
let first: SeedFinanceResult;

beforeAll(async () => {
  tenantId = (await seedTenant(spec, await hashPassword("dev-seed-password-123"))).tenantId;
  first = await seedFinanceData(tenantId);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 4 development seed", () => {
  it("creates materials, each with an approved version-1 cost", async () => {
    expect(first).toMatchObject({ materials: MATERIAL_SPECS.length, costVersions: MATERIAL_SPECS.length });
    await withTenant(tenantId, async (tx) => {
      const materials = await tx.material.findMany({ include: { costVersions: true }, orderBy: { code: "asc" } });
      expect(materials).toHaveLength(MATERIAL_SPECS.length);
      for (const material of materials) {
        const expected = MATERIAL_SPECS.find((m) => m.code === material.code)!;
        expect(material.costVersions).toHaveLength(1);
        expect(material.costVersions[0]).toMatchObject({ versionNumber: 1, status: "APPROVED", currency: "USD", unitCostMinor: expected.unitCostMinor, effectiveTo: null });
      }
    });
  });

  it("creates the default approval policies, active, version 1, naming real approver permissions", async () => {
    expect(first.approvalPolicies).toBe(APPROVAL_POLICY_SPECS.length);
    await withTenant(tenantId, async (tx) => {
      const policies = await tx.approvalPolicy.findMany();
      expect(policies).toHaveLength(APPROVAL_POLICY_SPECS.length);
      for (const policy of policies) {
        expect(policy).toMatchObject({ active: true, version: 1 });
        expect(isPermissionKey(policy.approverPermission), policy.code).toBe(true);
        expect([1, 2]).toContain(policy.requiredApprovals);
      }
      // Refund tiers: a small refund needs one approval, a large one needs two, and the tiers touch without overlapping.
      const refunds = policies.filter((p) => p.subjectType === "REFUND").sort((a, b) => Number(a.minAmountMinor - b.minAmountMinor));
      expect(refunds.map((p) => p.requiredApprovals)).toEqual([1, 2]);
      expect(refunds[0].maxAmountMinor).toBe(refunds[1].minAmountMinor);
      expect(policies.find((p) => p.subjectType === "CHARGEBACK_WRITE_OFF")?.requiredApprovals).toBe(2);
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    expect(await seedFinanceData(tenantId)).toEqual({ materials: 0, costVersions: 0, approvalPolicies: 0 });
    await withTenant(tenantId, async (tx) => {
      expect(await tx.material.count()).toBe(MATERIAL_SPECS.length);
      expect(await tx.materialCostVersion.count()).toBe(MATERIAL_SPECS.length);
      expect(await tx.approvalPolicy.count()).toBe(APPROVAL_POLICY_SPECS.length);
    });
  });
});
