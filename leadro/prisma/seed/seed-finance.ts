import { withTenant } from "../../src/server/db";
import { APPROVAL_POLICY_SPECS, MATERIAL_SPECS } from "./finance-specs";

export interface SeedFinanceResult {
  materials: number;
  costVersions: number;
  approvalPolicies: number;
}

/**
 * Seeds the Phase 4 starter data for ONE existing tenant: a few materials each with an APPROVED version-1 cost, and the
 * default approval policies. Each part is idempotent (existing rows are never touched), so re-running it, or running it on a
 * tenant seeded before Phase 4, is safe. Seeded costs are approved directly (no request): they are demonstration data.
 */
export async function seedFinanceData(tenantId: string): Promise<SeedFinanceResult> {
  return withTenant(tenantId, async (tx) => {
    const result: SeedFinanceResult = { materials: 0, costVersions: 0, approvalPolicies: 0 };
    const now = new Date();
    const author =
      (await tx.user.findFirst({ where: { email: { startsWith: "finance@" } }, select: { id: true } })) ??
      (await tx.user.findFirst({ where: { email: { startsWith: "owner@" } }, select: { id: true } })) ??
      (await tx.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }));

    for (const spec of MATERIAL_SPECS) {
      let material = await tx.material.findFirst({ where: { code: spec.code }, select: { id: true } });
      if (!material) {
        material = await tx.material.create({
          data: { tenantId, code: spec.code, name: spec.name, unit: spec.unit, supplier: spec.supplier, createdById: author?.id ?? null },
          select: { id: true },
        });
        result.materials += 1;
      }
      if ((await tx.materialCostVersion.count({ where: { materialId: material.id } })) === 0) {
        await tx.materialCostVersion.create({
          data: {
            tenantId,
            materialId: material.id,
            versionNumber: 1,
            unitCostMinor: spec.unitCostMinor,
            currency: "USD",
            // Far enough back that any seeded job usage falls inside the version.
            effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
            status: "APPROVED",
            approvedAt: now,
            createdById: author?.id ?? null,
            note: "Seeded demonstration cost",
          },
        });
        result.costVersions += 1;
      }
    }

    for (const spec of APPROVAL_POLICY_SPECS) {
      if (await tx.approvalPolicy.findFirst({ where: { code: spec.code }, select: { id: true } })) continue;
      await tx.approvalPolicy.create({
        data: { tenantId, ...spec, version: 1, active: true, currency: "USD", createdById: author?.id ?? null },
      });
      result.approvalPolicies += 1;
    }
    return result;
  });
}
